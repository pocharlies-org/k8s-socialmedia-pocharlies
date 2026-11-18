import assert from 'node:assert/strict';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('Scratch DATABASE_URL is required');
const client = new pg.Client({connectionString: process.env.DATABASE_URL});
await client.connect();
const originalQuery = pg.Pool.prototype.query;
const previousAccount = process.env.CONNECTOR_ACCOUNT;
pg.Pool.prototype.query = function (sql, params = []) { return client.query(sql, params); };
try {
  await client.query(`CREATE TEMP TABLE whatsapp_message_payloads (
    wa_message_id text PRIMARY KEY, account text, conversation_id text,
    message_key jsonb, message_payload jsonb, message_timestamp_ms bigint
  )`);
  const now = Date.now();
  await client.query(`INSERT INTO whatsapp_message_payloads
    SELECT 'professional:pin-' || lpad(n::text, 4, '0'), 'professional', 'professional:123@g.us',
      jsonb_build_object('id', 'pin-' || lpad(n::text, 4, '0'), 'remoteJid', '123@g.us'),
      CASE WHEN n % 2 = 0 THEN jsonb_build_object('ephemeralMessage', jsonb_build_object('message', payload)) ELSE payload END,
      $1::bigint
    FROM generate_series(1, 1201) n
    CROSS JOIN LATERAL (SELECT jsonb_build_object(
      'pinInChatMessage', jsonb_build_object('key',jsonb_build_object('id','target-' || n,'remoteJid','123@g.us'),
        'type',1,'senderTimestampMs',$1::bigint+n),
      'messageContextInfo',jsonb_build_object('messageAddOnDurationInSecs',86400)) payload) p`, [now]);
  await client.query(`INSERT INTO whatsapp_message_payloads
    SELECT 'foreign-' || n, CASE WHEN n=1 THEN 'personal' ELSE 'professional' END,
      CASE WHEN n=2 THEN 'professional:999@g.us' ELSE 'professional:123@g.us' END,
      '{}'::jsonb, jsonb_build_object('pinInChatMessage',jsonb_build_object('type',1)), $1::bigint
    FROM generate_series(1,2) n`, [now]);
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const {listCapturedPins, readPinnedMessages} = await import('./pinned-store.ts');
  let cursor = null;
  const ids = [];
  do {
    const page = await listCapturedPins('123@g.us', cursor, 100);
    ids.push(...page.items.map(item => item.key.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 1201);
  assert.equal(new Set(ids).size, 1201);
  assert.equal(ids[0], 'pin-0001');
  assert.equal(ids.at(-1), 'pin-1201');
  const result = await readPinnedMessages('123@g.us', {nowMs: now + 2000});
  assert.deepEqual(result.items.map(item => item.messageId), ['target-1201','target-1200','target-1199']);
  console.log('Pinned PostgreSQL: 1201 wrapped/direct actions, complete pagination, scope isolation and latest three pass');
} finally {
  pg.Pool.prototype.query = originalQuery;
  if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
  else process.env.CONNECTOR_ACCOUNT = previousAccount;
  await client.end();
}
