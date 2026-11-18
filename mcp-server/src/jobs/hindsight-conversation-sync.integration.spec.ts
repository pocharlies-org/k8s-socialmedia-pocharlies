/** Synthetic rows only; requires a disposable migrated hindsight_qa database. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { defaultRegistry } from '../domain/account-registry';
import { syncOptionsFromEnv } from './hindsight-sync-lib';
import { runConversationSyncPass } from './hindsight-conversation-sync';

const databaseUrl = process.env.HINDSIGHT_TEST_DATABASE_URL;
const integration = databaseUrl ? it : it.skip;
integration(
  'persists UUID mapping, append, edit, rename, selection withdrawal and hard delete',
  async () => {
    if (!new URL(databaseUrl!).pathname.startsWith('/hindsight_qa'))
      throw new Error('Disposable QA database required');
    const pool = new Pool({ connectionString: databaseUrl });
    const db = await pool.connect();
    const chat = `qa-conversation-${randomUUID()}@c.us`;
    const destination = `qa-conversation-${randomUUID()}`;
    const sender = chat;
    const ids = [randomUUID(), randomUUID()];
    const realName = 'Ari \u{1f337}';
    const renamedName = 'Ari \u{1f338}';
    const options = syncOptionsFromEnv({
      HINDSIGHT_SYNC_BATCH: '100',
      HINDSIGHT_SYNC_RETRY_MS: '1',
      HINDSIGHT_SYNC_CHAT_IDS: chat,
    });
    const accounts = defaultRegistry();
    const documents = new Map<string, string>();
    const operations = new Set<string>();
    const submissions: Array<{ content: string; updateMode?: string; operationId: string }> = [];
    let loseAck = true;
    const client = {
      getOperation: async (id: string) => ({
        operationId: id,
        status: operations.has(id) ? ('completed' as const) : ('not_found' as const),
      }),
      retryOperation: async (id: string) => ({ operationId: id }),
      retainDocument: async (input: {
        documentId: string;
        content: string;
        operationId: string;
        updateMode?: 'append' | 'replace';
      }) => {
        submissions.push(input);
        operations.add(input.operationId);
        documents.set(
          input.documentId,
          input.updateMode === 'append'
            ? documents.get(input.documentId) + '\n' + input.content
            : input.content
        );
        if (loseAck) {
          loseAck = false;
          throw new Error('Synthetic lost acknowledgement');
        }
        return { operationId: input.operationId };
      },
      deleteDocument: async (id: string) => {
        documents.delete(id);
      },
    };
    const pass = () => runConversationSyncPass(db, client, destination, accounts, options);
    const settle = async () => {
      for (let i = 0; i < 12; i++) {
        await pass();
        const {
          rows: [r],
        } = await db.query(
          `SELECT count(*)::int AS pending FROM hindsight_conversation_documents d
        JOIN hindsight_conversation_changes c USING(scope_key) WHERE d.destination=$1
        AND (d.pending IS NOT NULL OR d.source_revision<>c.revision)`,
          [destination]
        );
        if (!r.pending) return;
        await new Promise(resolve => setTimeout(resolve, 3));
      }
      throw new Error('QA did not settle');
    };
    try {
      await db.query(
        `INSERT INTO conversations(id,wa_chat_id,type,account,name) VALUES($1::text,$1::text,'INDIVIDUAL','personal','Ariadna')`,
        [chat]
      );
      await db.query(
        `INSERT INTO whatsapp_contacts(account,jid,name,push_name) VALUES('personal',$1,$2,'Push Alice')`,
        [sender, realName]
      );
      const insert = async (id: string, text: string, time: string) =>
        db.query(
          `INSERT INTO messages(id,conversation_id,wa_message_id,
      wa_timestamp,direction,sender_wa_id,content,content_hash,message_type,platform,account)
      VALUES($1::uuid,$2,$1::text,$3,'INBOUND',$4,$5,'qa','TEXT','whatsapp','personal')`,
          [id, chat, time, sender, text]
        );
      await insert(ids[0], 'Original', '2026-10-08T10:00:00Z');
      await settle();
      expect(submissions).toHaveLength(1);
      const {
        rows: [d],
      } = await db.query('SELECT * FROM hindsight_conversation_documents WHERE destination=$1', [
        destination,
      ]);
      expect(d.message_ids).toEqual([ids[0]]);
      expect(documents.get(d.document_id)).toContain(realName);
      expect(JSON.parse(documents.get(d.document_id)!.split('\n')[0]).title).toBe(realName);
      await insert(ids[1], 'Second', '2026-10-08T11:00:00Z');
      await settle();
      expect(submissions.at(-1)?.updateMode).toBe('append');
      await db.query("UPDATE messages SET content='Edited' WHERE id=$1", [ids[0]]);
      await settle();
      expect(submissions.at(-1)?.updateMode).toBe('replace');
      expect(documents.get(d.document_id)).not.toContain('Original');
      await db.query("UPDATE whatsapp_contacts SET name=$2 WHERE jid=$1 AND account='personal'", [
        sender,
        renamedName,
      ]);
      await settle();
      expect(JSON.parse(documents.get(d.document_id)!.split('\n')[0]).title).toBe(renamedName);
      expect(submissions.at(-1)?.updateMode).toBe('replace');
      options.chatIds = ['outside-selection'];
      await settle();
      expect(documents.size).toBe(0);
      options.chatIds = [chat];
      await settle();
      expect(documents.size).toBe(1);
      options.chatIds = ['outside-selection'];
      await settle();
      expect(documents.size).toBe(0);
      options.chatIds = [chat];
      await settle();
      expect(documents.size).toBe(1);
      await db.query('DELETE FROM messages WHERE id=ANY($1::uuid[])', [ids]);
      await settle();
      expect(documents.size).toBe(0);
      const {
        rows: [deleted],
      } = await db.query(
        'SELECT message_ids,confirmed,pending FROM hindsight_conversation_documents WHERE destination=$1',
        [destination]
      );
      expect(deleted.message_ids).toEqual([]);
      expect(deleted.pending).toBeNull();
    } finally {
      try {
        await db.query('DELETE FROM conversations WHERE id=$1', [chat]);
        await db.query('DELETE FROM whatsapp_contacts WHERE account=$1 AND jid=$2', [
          'personal',
          sender,
        ]);
      } finally {
        db.release();
        await pool.end();
      }
    }
  },
  30000
);

integration(
  'isolates provider/topic identities and queues OLD and NEW topic on a move',
  async () => {
    if (!new URL(databaseUrl!).pathname.startsWith('/hindsight_qa'))
      throw new Error('Disposable QA database required');
    const pool = new Pool({ connectionString: databaseUrl });
    const db = await pool.connect();
    const chat = `qa-topics-${randomUUID()}`;
    const destination = `qa-topics-${randomUUID()}`;
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const operations = new Set<string>();
    const documents = new Map<string, string>();
    const options = syncOptionsFromEnv({
      HINDSIGHT_SYNC_BATCH: '100',
      HINDSIGHT_SYNC_RETRY_MS: '1',
      HINDSIGHT_SYNC_CHAT_IDS: chat,
    });
    const client = {
      getOperation: async (id: string) => ({
        operationId: id,
        status: operations.has(id) ? ('completed' as const) : ('not_found' as const),
      }),
      retryOperation: async (id: string) => ({ operationId: id }),
      deleteDocument: async (id: string) => {
        documents.delete(id);
      },
      retainDocument: async (input: {
        documentId: string;
        content: string;
        operationId: string;
      }) => {
        operations.add(input.operationId);
        documents.set(input.documentId, input.content);
        return { operationId: input.operationId };
      },
    };
    const settle = async () => {
      for (let i = 0; i < 8; i++) {
        await runConversationSyncPass(db, client, destination, defaultRegistry(), options);
        await new Promise(resolve => setTimeout(resolve, 3));
      }
    };
    try {
      await db.query(
        `INSERT INTO conversations(id,wa_chat_id,type,account,name) VALUES($1::text,$1::text,'GROUP','personal','Synthetic topics')`,
        [chat]
      );
      for (let i = 0; i < 3; i++)
        await db.query(
          `INSERT INTO messages(id,conversation_id,wa_message_id,wa_timestamp,direction,
      sender_wa_id,content,content_hash,message_type,platform,account,metadata)
      VALUES($1::uuid,$2,$1::text,now(),'INBOUND','synthetic','Synthetic turn','qa','TEXT',$3,'personal',$4::jsonb)`,
          [
            ids[i],
            chat,
            i === 2 ? 'whatsapp' : 'telegram',
            JSON.stringify(
              i === 0 ? { topic_id: '', thread_id: 123 } : i === 1 ? { topic_id: 456 } : {}
            ),
          ]
        );
      await settle();
      const { rows: before } = await db.query(
        'SELECT platform,topic_id,message_ids FROM hindsight_conversation_documents WHERE destination=$1',
        [destination]
      );
      expect(before).toEqual(
        expect.arrayContaining([
          { platform: 'telegram', topic_id: '123', message_ids: [ids[0]] },
          { platform: 'telegram', topic_id: '456', message_ids: [ids[1]] },
          { platform: 'whatsapp', topic_id: '', message_ids: [ids[2]] },
        ])
      );
      await db.query(`UPDATE messages SET metadata='{"topic_id":789}'::jsonb WHERE id=$1`, [
        ids[0],
      ]);
      await settle();
      const { rows: after } = await db.query(
        'SELECT topic_id,message_ids FROM hindsight_conversation_documents WHERE destination=$1 AND platform=$2',
        [destination, 'telegram']
      );
      expect(after).toEqual(
        expect.arrayContaining([
          { topic_id: '123', message_ids: [] },
          { topic_id: '789', message_ids: [ids[0]] },
        ])
      );
      expect(documents.size).toBe(3);
    } finally {
      try {
        await db.query('DELETE FROM conversations WHERE id=$1', [chat]);
      } finally {
        db.release();
        await pool.end();
      }
    }
  },
  30000
);
