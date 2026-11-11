// Run only against a disposable QA database: creates and removes its own schema.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('scratch DATABASE_URL required');
const base = process.env.DATABASE_URL;
if (!/(qa|scratch|test)/i.test(new URL(base).pathname))
  throw new Error('Disposable QA/scratch/test database name required');
const admin = new pg.Client({ connectionString: base });
await admin.connect();
const schema = `qa_receipts_${process.pid}_${Date.now()}`;
await admin.query(`CREATE SCHEMA ${schema}`);
const dsn = new URL(base);
dsn.searchParams.set('options', `-csearch_path=${schema}`);
process.env.DATABASE_URL = dsn.toString();
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const store = await import('./message-receipts.ts');
const writer = await import('./db-writer.ts');
try {
  await db.query(`CREATE TABLE messages (id text PRIMARY KEY,wa_message_id text UNIQUE,account text,conversation_id text,platform text,direction text,status text,status_at timestamptz,is_deleted boolean DEFAULT false,metadata jsonb,deleted_at timestamptz);
    CREATE TABLE whatsapp_contacts (account text,jid text,name text,push_name text);
    CREATE TABLE whatsapp_message_payloads (wa_message_id text,account text,message_key jsonb,message_payload jsonb);
    CREATE TABLE conversations (id text,account text,is_group boolean,wa_chat_id text);`);
  const migration = readFileSync(
    new URL(
      '../../../mcp-server/src/infrastructure/database/migrations/038_whatsapp_message_receipts.sql',
      import.meta.url
    ),
    'utf8'
  );
  await db.query(`INSERT INTO messages VALUES
    ('backfill','BACK','personal','1@g.us','whatsapp','OUTBOUND',NULL,NULL,false,'{}'),
    ('failed','FAIL','personal','1@g.us','whatsapp','OUTBOUND','failed',NULL,false,'{}'),
    ('pending','PEND','personal','1@g.us','whatsapp','OUTBOUND','pending',NULL,false,'{}'),
    ('deleted','DEL','personal','1@g.us','whatsapp','OUTBOUND',NULL,NULL,true,'{}'),
    ('uncaptured','UNC','personal','1@g.us','whatsapp','OUTBOUND',NULL,NULL,false,'{}');
    INSERT INTO whatsapp_message_payloads SELECT wa_message_id,account,'{"fromMe":true}','{"conversation":"captured"}' FROM messages WHERE id<>'uncaptured';`);
  await db.query(
    'UPDATE messages SET metadata=\'{"deleted_at":"2026-01-01T10:00:00Z"}\' WHERE id=\'deleted\''
  );
  await db.query(migration);
  await db.query(migration);
  assert.equal(
    (
      await db.query("SELECT deleted_at FROM messages WHERE id='deleted'")
    ).rows[0].deleted_at.toISOString(),
    '2026-01-01T10:00:00.000Z'
  );
  await store.ensureMessageReceiptTables();
  assert.deepEqual(
    (await db.query('SELECT status FROM messages ORDER BY id')).rows.map(r => r.status),
    ['sent', null, 'failed', 'pending', null]
  );
  const metadataBefore = (await db.query('SELECT metadata FROM messages ORDER BY id')).rows;
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const person = (participantId, aliases = [participantId]) => ({
    participantId,
    aliases,
    name: null,
  });
  const evidence = (identity, fields = {}) => ({
    ...identity,
    deliveredAt: null,
    readAt: null,
    playedAt: null,
    ...fields,
  });
  const pn = '123@s.whatsapp.net',
    lid = '456@lid',
    other = '999@s.whatsapp.net';
  // Receipt arrives before message, before snapshot, and under a LID.
  await store.recordMessageReceipt(
    '1@g.us',
    'M1',
    evidence(person(lid), { readAt: '2026-01-01T00:02:00Z' })
  );
  await db.query(
    `INSERT INTO messages VALUES ('m1','M1','personal','1@g.us','whatsapp','OUTBOUND',NULL,NULL,false,'{"source":"history"}')`
  );
  let info = await store.getMessageReceiptInfo('1@g.us', 'M1');
  assert.equal(info.recipientCount, null);
  assert.equal(info.completeRecipients, false);
  assert.equal(info.receipts.length, 1);
  assert.equal(info.status, 'sent');
  await store.recordRecipientSnapshot('1@g.us', 'M1', [person(pn, [pn, lid]), person(other)]);
  await store.recordMessageReceipt(
    '1@g.us',
    'M1',
    evidence(person(pn), { deliveredAt: '2026-01-01T00:01:00Z' })
  );
  info = await store.getMessageReceiptInfo('1@g.us', 'M1');
  assert.equal(info.status, 'sent');
  assert.equal(info.receipts.length, 2);
  assert.equal(info.recipientCount, 2);
  // Concurrent, out-of-order alias updates don't lose other fields or duplicate a recipient.
  await Promise.all([
    store.recordMessageReceipt(
      '1@g.us',
      'M1',
      evidence(person(pn, [pn, lid]), { playedAt: '2026-01-01T00:04:00Z' })
    ),
    store.recordMessageReceipt(
      '1@g.us',
      'M1',
      evidence(person(lid), { readAt: '2026-01-01T00:03:00Z' })
    ),
    store.recordMessageReceipt(
      '1@g.us',
      'M1',
      evidence(person(other), { deliveredAt: '2026-01-01T00:02:00Z' })
    ),
  ]);
  info = await store.getMessageReceiptInfo('1@g.us', 'M1');
  assert.equal(info.status, 'delivered');
  assert.equal(info.receipts.length, 2);
  assert.equal(info.receipts.find(r => r.participantId === pn).readAt, '2026-01-01T00:02:00.000Z');
  await store.recordMessageReceipt(
    '1@g.us',
    'M1',
    evidence(person(other), { readAt: '2026-01-01T00:05:00Z' })
  );
  await store.recordAggregateStatus('1@g.us', 'M1', 'sent');
  info = await store.getMessageReceiptInfo('1@g.us', 'M1');
  assert.equal(info.status, 'read');
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM whatsapp_message_receipts WHERE message_id='M1'`
      )
    ).rows[0].n,
    2
  );
  await store.recordRecipientSnapshot('1@g.us', 'M1', [person(other)]);
  assert.equal((await store.getMessageReceiptInfo('1@g.us', 'M1')).recipientCount, 2);
  // Same message id in another chat/account has isolated receipts.
  await store.recordMessageReceipt(
    '2@g.us',
    'M1',
    evidence(person(other), { readAt: '2026-01-02T00:00:00Z' })
  );
  await assert.rejects(store.getMessageReceiptInfo('2@g.us', 'M1'), /not found/);
  process.env.CONNECTOR_ACCOUNT = 'professional';
  await store.recordMessageReceipt(
    '1@g.us',
    'M1',
    evidence(person(other), { readAt: '2026-01-02T00:00:00Z' })
  );
  await assert.rejects(store.getMessageReceiptInfo('1@g.us', 'M1'), /not found/);
  await db.query(`INSERT INTO messages VALUES ('pro','professional:M1','professional','professional:1@g.us','whatsapp','OUTBOUND','sent',NULL,false,'{}'),
    ('inbound','professional:IN','professional','professional:1@g.us','whatsapp','INBOUND',NULL,NULL,false,'{}')`);
  assert.equal((await store.getMessageReceiptInfo('1@g.us', 'M1')).receipts.length, 1);
  await assert.rejects(store.getMessageReceiptInfo('1@g.us', 'IN'), /outbound/);
  // A PN receipt can predate the namespaced professional LID conversation.
  await store.recordMessageReceipt(
    '346789@c.us',
    'DIRECT',
    evidence(person('346789@s.whatsapp.net'), { readAt: '2026-01-03T10:00:00Z' })
  );
  await store.recordAggregateStatus('346789@c.us', 'DIRECT', 'read');
  await db.query(`INSERT INTO conversations VALUES ('professional:987@lid','professional',false,'professional:346789@s.whatsapp.net');
    INSERT INTO messages VALUES ('direct','professional:DIRECT','professional','professional:987@lid','whatsapp','OUTBOUND',NULL,NULL,false,'{}');`);
  await store.recordAggregateStatus('987@lid', 'DIRECT', 'sent');
  const late = await store.getMessageReceiptInfo('987@lid', 'DIRECT');
  assert.equal(late.status, 'read');
  assert.equal(late.receipts[0].readAt, '2026-01-03T10:00:00.000Z');
  assert.equal(
    (await db.query("SELECT status FROM messages WHERE id='direct'")).rows[0].status,
    'read'
  );
  assert.equal((await store.getMessageReceiptInfo('346789@c.us', 'DIRECT')).chatId, '346789@c.us');
  process.env.CONNECTOR_ACCOUNT = 'personal';
  await writer.setMessageStatus('M1', 'failed');
  await writer.setMessageStatus('DEL', 'failed');
  assert.equal(
    (await db.query("SELECT status FROM messages WHERE id='m1'")).rows[0].status,
    'read'
  );
  await writer.setMessageStatus('FAIL', 'read');
  await writer.setMessageStatus('DEL', 'sent');
  assert.equal(
    (await db.query(`SELECT status FROM messages WHERE id='failed'`)).rows[0].status,
    'failed'
  );
  assert.equal(
    (await db.query(`SELECT status FROM messages WHERE id='deleted'`)).rows[0].status,
    null
  );
  assert.deepEqual(
    (
      await db.query(
        `SELECT metadata FROM messages WHERE id IN ('backfill','failed','pending','deleted','uncaptured') ORDER BY id`
      )
    ).rows,
    metadataBefore
  );
  assert.equal(
    (await db.query(`SELECT metadata FROM messages WHERE id='m1'`)).rows[0].metadata.source,
    'history'
  );
  console.log(
    'PASS migration idempotence/backfill; unknown historical totals; before-row receipts; concurrent PN/LID dedup; all-recipient aggregation; monotonic status; immutable send snapshot; account/chat scope; outbound validation; untouched metadata'
  );
} finally {
  await writer.getPool().end();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
