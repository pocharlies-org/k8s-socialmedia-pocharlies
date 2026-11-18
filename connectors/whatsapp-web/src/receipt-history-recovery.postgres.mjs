// Disposable database only. The fake provider emits real-shaped history events; no network send.
import assert from 'node:assert/strict';
import pg from 'pg';
if (
  !process.env.DATABASE_URL ||
  !/(qa|scratch|test)/i.test(new URL(process.env.DATABASE_URL).pathname)
)
  throw new Error('Disposable QA/scratch/test database name required');
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
const schema = `qa_receipt_recovery_${process.pid}_${Date.now()}`;
await admin.query(`CREATE SCHEMA ${schema}`);
const dsn = new URL(process.env.DATABASE_URL);
dsn.searchParams.set('options', `-csearch_path=${schema}`);
process.env.DATABASE_URL = dsn.toString();
process.env.CONNECTOR_ACCOUNT = 'professional';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const { BaileysClient } = await import('./baileys-client.ts');
const store = await import('./message-receipts.ts');
const writer = await import('./db-writer.ts');
const { proto } = await import('@whiskeysockets/baileys');
let client;
try {
  await db.query(`CREATE TABLE messages (id text PRIMARY KEY,wa_message_id text UNIQUE,account text,conversation_id text,platform text,direction text,status text,status_at timestamptz,is_deleted boolean DEFAULT false,metadata jsonb,content text);
    CREATE TABLE whatsapp_contacts (account text,jid text,name text,push_name text);
    CREATE TABLE conversations (id text,account text,is_group boolean,wa_chat_id text);
    CREATE TABLE whatsapp_message_keys (wa_message_id text PRIMARY KEY,conversation_id text,remote_jid text,from_me boolean,participant_jid text,message_timestamp_ms bigint);`);
  await store.ensureMessageReceiptTables();
  await db.query(`INSERT INTO messages VALUES
    ('target','professional:M1','professional','professional:1@g.us','whatsapp','OUTBOUND','sent',NULL,false,'{"source":"history"}','original'),
    ('next','professional:NEXT','professional','professional:1@g.us','whatsapp','INBOUND',NULL,NULL,false,'{}','next'),
    ('foreign','FOREIGN','personal','1@g.us','whatsapp','INBOUND',NULL,NULL,false,'{}','foreign'),
    ('otherchat','professional:OTHERCHAT','professional','professional:2@g.us','whatsapp','INBOUND',NULL,NULL,false,'{}','otherchat'),
    ('latest','professional:LATEST','professional','professional:3@g.us','whatsapp','OUTBOUND','sent',NULL,false,'{}','latest');
    INSERT INTO whatsapp_message_keys VALUES
    ('professional:M1','professional:1@g.us','1@g.us',true,NULL,1790000000000),
    ('professional:NEXT','professional:1@g.us','1@g.us',false,NULL,1790000001000),
    ('FOREIGN','1@g.us','1@g.us',false,NULL,1790000000500),
    ('professional:OTHERCHAT','professional:2@g.us','2@g.us',false,NULL,1790000000300),
    ('professional:LATEST','professional:3@g.us','3@g.us',true,NULL,1790000000000);`);
  const target = await store.receiptRecoveryTarget('1@g.us', 'M1');
  assert.equal((await store.receiptRecoveryAnchor(target)).key.id, 'NEXT');
  assert.equal(
    await store.receiptRecoveryAnchor(await store.receiptRecoveryTarget('3@g.us', 'LATEST')),
    null
  );
  const before = (await db.query('SELECT id,metadata,content FROM messages ORDER BY id')).rows;
  const handlers = {};
  const requests = [];
  client = new BaileysClient('/tmp/unused', 'key');
  client.ready = true;
  client.sock = {
    ev: {
      on: (event, handler) => {
        handlers[event] = handler;
      },
    },
    fetchMessageHistory: async (...args) => {
      requests.push(args);
      return 'SESSION';
    },
  };
  client.bindSocketEvents(async () => {});
  const response = await client.getMessageInfo('1@g.us', 'M1');
  assert.equal(response.recovery.state, 'pending');
  for (let n = 0; n < 20 && !requests.length; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 10);
  assert.equal(requests[0][1].id, 'NEXT');
  assert.equal(requests[0][2], 1790000001000);
  await client.getMessageInfo('1@g.us', 'M1');
  assert.equal(requests.length, 1);
  const receipt = {
    userJid: '123@s.whatsapp.net',
    receiptTimestamp: 1790000000,
    readTimestamp: 1790000010,
  };
  await handlers['messaging-history.set']({
    syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
    peerDataRequestSessionId: 'SESSION',
    chats: [{ id: 'unrelated@g.us', name: 'must not write' }],
    contacts: [{ id: 'unrelated' }],
    messages: [
      {
        key: { remoteJid: '2@g.us', id: 'M1', fromMe: true },
        userReceipt: [{ userJid: '999@s.whatsapp.net', readTimestamp: 1790000099 }],
      },
      {
        key: { remoteJid: '1@g.us', id: 'M1', fromMe: false },
        userReceipt: [{ userJid: '999@s.whatsapp.net', readTimestamp: 1790000099 }],
      },
      {
        key: { remoteJid: '1@g.us', id: 'M1', fromMe: true },
        message: { conversation: 'must not overwrite' },
        userReceipt: [receipt],
      },
    ],
  });
  const result = await client.getMessageInfo('1@g.us', 'M1');
  assert.equal(result.recovery.state, 'complete');
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].readAt, new Date(receipt.readTimestamp * 1000).toISOString());
  assert.equal(result.recipientCount, null);
  assert.equal(result.status, 'sent');
  assert.equal(result.completeRecipients, false);
  assert.equal(client.historyBackfillRequestedUntil, 0);
  assert.equal(client.chatStore.size, 0);
  assert.deepEqual(
    (await db.query('SELECT id,metadata,content FROM messages ORDER BY id')).rows,
    before
  );
  assert.equal((await db.query('SELECT count(*)::int AS n FROM whatsapp_contacts')).rows[0].n, 0);
  assert.equal(
    (await db.query('SELECT account FROM whatsapp_message_receipts')).rows[0].account,
    'professional'
  );
  await assert.rejects(client.getMessageInfo('2@g.us', 'M1'), /not found/);
  assert.equal(requests.length, 1);
  client.ready = false;
  assert.equal((await client.getMessageInfo('3@g.us', 'LATEST')).recovery.state, 'unsupported');
  assert.equal(requests.length, 1);
  console.log(
    'PASS real PG successor/account/chat anchor; fake-socket history userReceipt persisted before generic gate; coalesced read; no unrelated rows/content/metadata/contact writes; unknown historical total; outbound scope; offline fallback'
  );
} finally {
  client?.receiptHistoryRecovery.stop();
  await writer.getPool().end();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
