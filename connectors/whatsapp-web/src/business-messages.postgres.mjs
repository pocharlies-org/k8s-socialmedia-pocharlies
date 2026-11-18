// Run only against a disposable QA database. All rows live in a unique schema.
import assert from 'node:assert/strict';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('scratch DATABASE_URL required');
const base = process.env.DATABASE_URL;
if (!/(qa|scratch|test)/i.test(new URL(base).pathname))
  throw new Error('Disposable QA/scratch/test database name required');
const admin = new pg.Client({ connectionString: base });
await admin.connect();
const schema = `qa_business_${process.pid}_${Date.now()}`;
await admin.query(`CREATE SCHEMA ${schema}`);
const dsn = new URL(base);
dsn.searchParams.set('options', `-csearch_path=${schema}`);
process.env.DATABASE_URL = dsn.toString();
process.env.CONNECTOR_ACCOUNT = 'professional';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const writer = await import('./db-writer.ts');
const { BUSINESS_MESSAGE_TYPES } = await import('./business-message-text.ts');
try {
  await db.query(`CREATE TABLE messages (
    id text PRIMARY KEY DEFAULT md5(random()::text), wa_message_id text UNIQUE,
    conversation_id text, sender_wa_id text, wa_timestamp timestamptz, direction text,
    content text, message_type text, is_forwarded boolean, reply_to_message_id text,
    platform text, metadata jsonb, account text, is_edited boolean DEFAULT false,
    is_deleted boolean DEFAULT false);
    CREATE TABLE whatsapp_message_payloads (wa_message_id text PRIMARY KEY, message_payload jsonb);`);
  const data = (id, messageType, content) => ({
    waMessageId: id, conversationId: '123@lid', senderWaId: '123@lid',
    waTimestamp: new Date('2026-10-13T00:00:00Z'), direction: 'INBOUND',
    messageType, content, isForwarded: false,
  });
  for (const type of [...BUSINESS_MESSAGE_TYPES, 'PLACEHOLDERMESSAGE']) {
    const id = `CASE_${type}`;
    await db.query(`INSERT INTO messages (wa_message_id,account,platform,message_type,metadata)
      VALUES ($1,'professional','whatsapp',$2,'{"kept":"original"}')`, [`professional:${id}`, type]);
    await db.query('INSERT INTO whatsapp_message_payloads VALUES ($1,$2)', [`professional:${id}`, { secret: 'opaque-provider-data' }]);
    const payloadBefore = (await db.query('SELECT message_payload FROM whatsapp_message_payloads WHERE wa_message_id=$1', [`professional:${id}`])).rows[0];
    assert.ok(await writer.storeMessage(data(id, type === 'PLACEHOLDERMESSAGE' ? 'TEXT' : type, 'Visible label')));
    const row = (await db.query('SELECT * FROM messages WHERE wa_message_id=$1', [`professional:${id}`])).rows[0];
    assert.equal(row.content, 'Visible label');
    assert.equal(row.metadata.kept, 'original');
    assert.equal(row.metadata.contentUnavailable, false);
    assert.deepEqual((await db.query('SELECT message_payload FROM whatsapp_message_payloads WHERE wa_message_id=$1', [`professional:${id}`])).rows[0], payloadBefore);
  }
  for (const [id, content, edited, account, platform] of [
    ['NONEMPTY', 'Keep existing text', false, 'professional', 'whatsapp'],
    ['EDITED', null, true, 'professional', 'whatsapp'],
    ['FOREIGN', null, false, 'personal', 'whatsapp'],
    ['PLATFORM', null, false, 'professional', 'telegram'],
  ]) {
    await db.query(`INSERT INTO messages (wa_message_id,account,platform,message_type,content,is_edited,metadata)
      VALUES ($1,$2,$3,'TEMPLATEMESSAGE',$4,$5,'{"kept":"original"}')`, [`professional:${id}`, account, platform, content, edited]);
    const before = (await db.query('SELECT * FROM messages WHERE wa_message_id=$1', [`professional:${id}`])).rows[0];
    assert.equal(await writer.storeMessage(data(id, 'TEMPLATEMESSAGE', 'New text')), null);
    assert.deepEqual((await db.query('SELECT * FROM messages WHERE wa_message_id=$1', [`professional:${id}`])).rows[0], before);
  }
  assert.equal(await writer.storeMessage(data('CASE_BUTTONSMESSAGE', 'PLACEHOLDERMESSAGE', null)), null);
  assert.equal((await db.query("SELECT content FROM messages WHERE wa_message_id='professional:CASE_BUTTONSMESSAGE'")).rows[0].content, 'Visible label');
  console.log('business-message PostgreSQL recovery, preservation and isolation: PASS');
} finally {
  await writer.getPool().end();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
