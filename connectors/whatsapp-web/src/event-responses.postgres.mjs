// Use a disposable PostgreSQL database. All fixtures live in a temporary table.
import assert from 'node:assert/strict';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('Scratch DATABASE_URL is required');
const client = new pg.Client({connectionString: process.env.DATABASE_URL});
await client.connect();
const originalQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (sql, params = []) { return client.query(sql, params); };
const previousAccount = process.env.CONNECTOR_ACCOUNT;
try {
  await client.query(`CREATE TEMP TABLE whatsapp_message_payloads (
    wa_message_id text PRIMARY KEY, account text, conversation_id text,
    message_key jsonb, message_payload jsonb, message_timestamp_ms bigint
  )`);
  await client.query(`INSERT INTO whatsapp_message_payloads
    SELECT 'professional:r' || lpad(n::text, 4, '0'), 'professional', 'professional:123@g.us',
      jsonb_build_object('id', 'r' || lpad(n::text, 4, '0'), 'remoteJid', '123@g.us'),
      CASE WHEN n % 2 = 0 THEN
        jsonb_build_object('ephemeralMessage', jsonb_build_object('message',
          jsonb_build_object('encEventResponseMessage', jsonb_build_object('eventCreationMessageKey', jsonb_build_object('id', 'event-1')))))
      ELSE jsonb_build_object('encEventResponseMessage', jsonb_build_object('eventCreationMessageKey', jsonb_build_object('id', 'event-1'))) END,
      NULL FROM generate_series(1, 1201) n`);
  await client.query(`INSERT INTO whatsapp_message_payloads
    SELECT 'other-' || n, CASE WHEN n = 1 THEN 'personal' ELSE 'professional' END,
      CASE WHEN n = 2 THEN 'professional:999@g.us' ELSE 'professional:123@g.us' END,
      '{}'::jsonb,
      jsonb_build_object('encEventResponseMessage', jsonb_build_object('eventCreationMessageKey',
        jsonb_build_object('id', CASE WHEN n = 3 THEN 'other-event' ELSE 'event-1' END))), NULL
    FROM generate_series(1, 3) n`);
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const {listCapturedEventResponses} = await import('./durable-message-store.ts');
  let cursor = null;
  const ids = [];
  do {
    const result = await listCapturedEventResponses('event-1', '123@g.us', {cursor, limit: 100});
    ids.push(...result.items.map(item => item.waMessageId));
    cursor = result.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 1201);
  assert.equal(new Set(ids).size, 1201);
  assert.equal(ids[0], 'r0001');
  assert.equal(ids.at(-1), 'r1201');
  assert.deepEqual(await listCapturedEventResponses('missing', '123@g.us'), {items: [], nextCursor: null});
  console.log('RSVP PostgreSQL: 1201 direct/wrapped replies, complete pagination and scope isolation pass');
} finally {
  pg.Pool.prototype.query = originalQuery;
  if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
  else process.env.CONNECTOR_ACCOUNT = previousAccount;
  await client.end();
}
