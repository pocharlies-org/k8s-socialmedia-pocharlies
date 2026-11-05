/** Opt-in protocol test: only synthetic data in a disposable migrated database. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { useTestAccounts } from '../domain/test-accounts';
import { getAccounts } from '../domain/account-registry';
import {
  HindsightClient,
  hindsightConfigFromEnv,
  socialmediaScopeTag,
  socialmediaDocumentId,
} from '../infrastructure/hindsight-client';
import { destinationKey, runSyncPass, syncOptionsFromEnv } from './hindsight-sync-lib';

const databaseUrl = process.env.HINDSIGHT_TEST_DATABASE_URL;
const apiUrl = process.env.HINDSIGHT_TEST_URL;
const liveTest = databaseUrl && apiUrl ? it : it.skip;
const databaseTest = databaseUrl ? it : it.skip;

databaseTest(
  'valida triggers, SQL, confirmaciones y tombstones sobre PostgreSQL real',
  async () => {
    if (!new URL(databaseUrl!).pathname.startsWith('/hindsight_qa')) {
      throw new Error('HINDSIGHT_TEST_DATABASE_URL must target a disposable hindsight_qa database');
    }
    const pool = new Pool({ connectionString: databaseUrl });
    const db = await pool.connect();
    const id = randomUUID();
    const chat = `qa-${randomUUID()}`;
    const destination = destinationKey('http://synthetic-qa', `socialmedia-qa-${randomUUID()}`);
    const options = syncOptionsFromEnv({
      HINDSIGHT_SYNC_BATCH: '10',
      HINDSIGHT_SYNC_RETRY_MS: '1',
      HINDSIGHT_SYNC_CHAT_IDS: chat,
    });
    useTestAccounts({ whatsapp: { personal: 'http://qa-wa' }, telegram: {} });
    const operations = new Map<string, 'completed'>();
    const documents = new Map<string, string>();
    let submissions = 0;
    let lostAcknowledgement = true;
    const client = {
      getOperation: async (operationId: string) => ({
        operationId,
        status: operations.get(operationId) || ('not_found' as const),
      }),
      retryOperation: async (operationId: string) => ({ operationId }),
      retainDocument: async (input: {
        documentId: string;
        operationId: string;
        content: string;
      }) => {
        submissions++;
        operations.set(input.operationId, 'completed');
        documents.set(input.documentId, input.content);
        if (lostAcknowledgement) {
          lostAcknowledgement = false;
          throw new Error('Synthetic lost response');
        }
        return { operationId: input.operationId };
      },
      deleteDocument: async (documentId: string) => {
        documents.delete(documentId);
      },
    };
    const pass = () => runSyncPass(db, client, destination, getAccounts(), options);
    try {
      await db.query(
        `INSERT INTO conversations(id,wa_chat_id,type,account,name)
      VALUES($1::text,$1::text,'INDIVIDUAL','personal','Synthetic QA')`,
        [chat]
      );
      await db.query(
        `INSERT INTO messages(id,conversation_id,wa_message_id,wa_timestamp,direction,
      sender_wa_id,content,content_hash,message_type,platform,account)
      VALUES($1::uuid,$2,$1::text,now(),'INBOUND','synthetic','Texto original','qa','TEXT','whatsapp','personal')`,
        [id, chat]
      );
      expect((await pass()).failed).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 5));
      expect((await pass()).completed).toBe(1);
      expect(submissions).toBe(1);
      await db.query("UPDATE messages SET content='Texto editado' WHERE id=$1", [id]);
      expect((await pass()).accepted).toBe(1);
      // Delete while the local ledger still regards the accepted retain as pending.
      await db.query('DELETE FROM messages WHERE id=$1', [id]);
      await new Promise(resolve => setTimeout(resolve, 5));
      expect((await pass()).completed).toBe(1);
      expect(documents.get(socialmediaDocumentId(id))).toContain('Texto editado');
      expect((await pass()).completed).toBe(1);
      expect(documents.has(socialmediaDocumentId(id))).toBe(false);
      const state = await db.query(
        `SELECT l.status,l.is_deleted FROM hindsight_sync_ledger l
      WHERE destination=$1 AND message_id=$2`,
        [destination, id]
      );
      expect(state.rows).toEqual([{ status: 'completed', is_deleted: true }]);
    } finally {
      try {
        await db.query('DELETE FROM conversations WHERE id=$1', [chat]);
      } finally {
        db.release();
        await pool.end();
      }
    }
  }
);

liveTest(
  'indexa, aisla, edita y borra mensajes contra Hindsight y PostgreSQL reales',
  async () => {
    if (!new URL(databaseUrl!).pathname.startsWith('/hindsight_qa')) {
      throw new Error('HINDSIGHT_TEST_DATABASE_URL must target a disposable hindsight_qa database');
    }
    const bankId = `socialmedia-qa-${randomUUID()}`;
    const config = hindsightConfigFromEnv({
      HINDSIGHT_URL: apiUrl,
      HINDSIGHT_BANK_ID: bankId,
      HINDSIGHT_TIMEOUT_MS: '60000',
      HINDSIGHT_API_KEY: process.env.HINDSIGHT_TEST_API_KEY,
    });
    const client = new HindsightClient(config);
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const db = await pool.connect();
    const ids = [randomUUID(), randomUUID()];
    const chats = [`qa-${randomUUID()}`, `secondary:qa-${randomUUID()}`];
    const options = syncOptionsFromEnv({
      HINDSIGHT_SYNC_BATCH: '10',
      HINDSIGHT_SYNC_RETRY_MS: '1',
      HINDSIGHT_SYNC_CHAT_IDS: chats.join(','),
    });
    useTestAccounts({
      whatsapp: { personal: 'http://qa-wa', secondary: 'http://qa-wa-2' },
      telegram: {},
    });
    const destination = destinationKey(config.url, config.bankId);
    let queued = false;
    let bankInitialized = false;
    const settle = async (expected: number) => {
      const end = Date.now() + 90000;
      while (Date.now() < end) {
        await runSyncPass(db, client, destination, getAccounts(), options);
        const { rows } = await db.query(
          `SELECT count(*)::int AS done FROM hindsight_sync_ledger l
        JOIN hindsight_sync_changes c ON c.message_id=l.message_id
        WHERE l.destination=$1 AND l.status='completed' AND l.source_revision=c.revision`,
          [destination]
        );
        if (rows[0].done === expected) return;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('Synthetic Hindsight operations did not complete within 90 seconds');
    };
    try {
      await client.initializeBank();
      bankInitialized = true;
      for (let i = 0; i < ids.length; i++) {
        const account = i ? 'secondary' : 'personal';
        await db.query(
          `INSERT INTO conversations(id,wa_chat_id,type,account,name)
        VALUES($1::text,$1::text,'INDIVIDUAL',$2,'Synthetic Hindsight QA')`,
          [chats[i], account]
        );
        await db.query(
          `INSERT INTO messages(id,conversation_id,wa_message_id,wa_timestamp,direction,
        sender_wa_id,content,content_hash,message_type,platform,account)
        VALUES($1::uuid,$2,$1::text,now(),'INBOUND','synthetic-sender',$3,'qa','TEXT','whatsapp',$4)`,
          [
            ids[i],
            chats[i],
            i
              ? 'El proyecto faro zafiro pertenece a la cuenta secundaria.'
              : 'El proyecto faro zafiro usa una maqueta azul de madera.',
            account,
          ]
        );
      }
      queued = true;
      await settle(2);
      const tag = socialmediaScopeTag('whatsapp', 'personal', 'personal');
      const hits = await client.recall({ query: 'proyecto faro zafiro', tags: [tag] });
      expect(hits.some(h => h.documentId === socialmediaDocumentId(ids[0]))).toBe(true);
      expect(hits.some(h => h.documentId === socialmediaDocumentId(ids[1]))).toBe(false);
      await db.query(
        "UPDATE messages SET content='El proyecto faro zafiro ahora usa acero verde.' WHERE id=$1",
        [ids[0]]
      );
      await settle(2);
      const edited = await client.recall({ query: 'proyecto faro zafiro', tags: [tag] });
      expect(
        edited
          .filter(h => h.documentId === socialmediaDocumentId(ids[0]))
          .map(h => h.text)
          .join(' ')
      ).toContain('acero verde');
      expect(
        edited
          .filter(h => h.documentId === socialmediaDocumentId(ids[0]))
          .map(h => h.text)
          .join(' ')
      ).not.toContain('maqueta azul');
      await db.query('DELETE FROM messages WHERE id=$1', [ids[0]]);
      await settle(2);
      const deleted = await client.recall({ query: 'proyecto faro zafiro', tags: [tag] });
      expect(deleted.some(h => h.documentId === socialmediaDocumentId(ids[0]))).toBe(false);
    } finally {
      // Only remove records created by this test. Reconcile submitted work before cleanup.
      try {
        if (queued) await settle(2);
        if (bankInitialized)
          for (const id of ids) await client.deleteDocument(socialmediaDocumentId(id));
        await db.query('DELETE FROM conversations WHERE id=ANY($1::text[])', [chats]);
      } finally {
        db.release();
        await pool.end();
      }
    }
  },
  240000
);
