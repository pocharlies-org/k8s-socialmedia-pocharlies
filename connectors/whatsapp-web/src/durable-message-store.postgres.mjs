import assert from 'node:assert/strict';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('Scratch DATABASE_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const originalQuery = pg.Pool.prototype.query;
const previousAccount = process.env.CONNECTOR_ACCOUNT;
const queries = [];
pg.Pool.prototype.query = function (sql, params = []) {
  queries.push({ sql, params });
  return client.query(sql, params);
};

const chat = '123@g.us';
const pageSize = 500;
const messageCount = 1201;
const now = Date.now();

function pageIds(page) {
  return page.items.map(item => item.key.id);
}

function asSqlLiteral(value) {
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function explainGeneric(name, query) {
  const used = [...query.sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
  assert.equal(Math.max(...used), query.params.length, `${name} query has dense parameters`);
  for (let index = 1; index <= query.params.length; index++)
    assert.ok(used.includes(index), `${name} query leaves $${index} unreferenced`);
  const types = query.params.map(value => (typeof value === 'number' ? 'integer' : 'text'));
  await client.query(`PREPARE ${name} (${types.join(', ')}) AS ${query.sql}`);
  const args = query.params.map(asSqlLiteral).join(', ');
  const result = await client.query(`EXPLAIN (COSTS OFF) EXECUTE ${name}(${args})`);
  return result.rows.map(row => row['QUERY PLAN']).join('\n');
}

async function collectPins(first, second, listPins) {
  const items = [...first.items, ...second.items];
  let cursor = second.nextCursor;
  while (cursor) {
    const page = await listPins(chat, cursor, pageSize);
    items.push(...page.items);
    cursor = page.nextCursor;
  }
  return items;
}

async function collectResponses(first, second, listResponses) {
  const items = [...first.items, ...second.items];
  let cursor = second.nextCursor;
  while (cursor) {
    const page = await listResponses('event-qa', chat, { cursor, limit: pageSize });
    items.push(...page.items);
    cursor = page.nextCursor;
  }
  return items;
}

try {
  await client.query(`CREATE TEMP TABLE whatsapp_message_payloads (
    wa_message_id text PRIMARY KEY, account text NOT NULL, conversation_id text NOT NULL,
    message_key jsonb NOT NULL, message_payload jsonb NOT NULL, message_timestamp_ms bigint
  )`);
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { EVENT_RESPONSE_PRESENT_SQL, PAYLOAD_PARTIAL_INDEX_DDL, PIN_ACTION_SQL } =
    await import('./durable-message-store.ts');
  const { listCapturedEventResponses } = await import('./durable-message-store.ts');

  await client.query(`INSERT INTO whatsapp_message_payloads
    SELECT 'professional:ordinary-' || lpad(n::text, 6, '0'),
      'professional', 'professional:123@g.us',
      jsonb_build_object('id', n::text, 'remoteJid', '123@g.us'),
      jsonb_build_object('conversation', 'ordinary payload'), $1::bigint
    FROM generate_series(1, 200000) n`, [now]);
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
    SELECT 'professional:rsvp-' || lpad(n::text, 4, '0'), 'professional', 'professional:123@g.us',
      jsonb_build_object('id', 'rsvp-' || lpad(n::text, 4, '0'), 'remoteJid', '123@g.us'),
      CASE WHEN n % 2 = 0 THEN jsonb_build_object('ephemeralMessage', jsonb_build_object('message', payload)) ELSE payload END,
      $1::bigint
    FROM generate_series(1, 1201) n
    CROSS JOIN LATERAL (SELECT jsonb_build_object(
      'encEventResponseMessage', jsonb_build_object(
        'eventCreationMessageKey', jsonb_build_object('id','event-qa'), 'encPayload','ciphertext-' || n)) payload) p`, [now]);
  await client.query(`INSERT INTO whatsapp_message_payloads
    VALUES
      ('personal:pin-wrong-account', 'personal', 'professional:123@g.us',
       '{"id":"wrong-account","remoteJid":"123@g.us"}',
       '{"pinInChatMessage":{"key":{"id":"wrong-account","remoteJid":"123@g.us"},"type":1},"encEventResponseMessage":{"eventCreationMessageKey":{"id":"event-qa"}}}', $1),
      ('professional:pin-wrong-chat', 'professional', 'professional:999@g.us',
       '{"id":"wrong-chat","remoteJid":"999@g.us"}',
       '{"pinInChatMessage":{"key":{"id":"wrong-chat","remoteJid":"999@g.us"},"type":1},"encEventResponseMessage":{"eventCreationMessageKey":{"id":"event-qa"}}}', $1)`, [now]);

  for (const ddl of PAYLOAD_PARTIAL_INDEX_DDL) await client.query(ddl);
  await client.query('ANALYZE whatsapp_message_payloads');
  const volatility = await client.query(`SELECT provolatile
    FROM pg_proc WHERE oid = 'jsonb_path_exists(jsonb,jsonpath,jsonb,boolean)'::regprocedure`);
  assert.equal(volatility.rows[0]?.provolatile, 'i', 'jsonb_path_exists index predicates are immutable');
  assert.ok(PAYLOAD_PARTIAL_INDEX_DDL.some(ddl => ddl.includes(`WHERE ${PIN_ACTION_SQL}`)));
  assert.ok(PAYLOAD_PARTIAL_INDEX_DDL.some(ddl => ddl.includes(`WHERE ${EVENT_RESPONSE_PRESENT_SQL}`)));

  const { listCapturedPins: listPins } = await import('./pinned-store.ts');
  const pinFirst = await listPins(chat, null, pageSize);
  const pinFirstQuery = queries.at(-1);
  const pinSecond = await listPins(chat, pinFirst.nextCursor, pageSize);
  const pinNextQuery = queries.at(-1);
  assert.equal(pinFirst.items.length, pageSize);
  assert.equal(pinFirst.nextCursor, 'pin-0500');
  assert.equal(pinSecond.items.length, pageSize);
  assert.equal(pageIds(pinFirst)[0], 'pin-0001');
  assert.equal(pageIds(pinSecond)[0], 'pin-0501');
  const pins = await collectPins(pinFirst, pinSecond, listPins);
  assert.equal(pins.length, messageCount);
  assert.equal(new Set(pageIds({ items: pins })).size, messageCount);
  assert.equal(pageIds({ items: pins }).at(-1), 'pin-1201');

  const responseFirst = await listCapturedEventResponses('event-qa', chat, { limit: pageSize });
  const responseFirstQuery = queries.at(-1);
  const responseSecond = await listCapturedEventResponses('event-qa', chat, {
    cursor: responseFirst.nextCursor,
    limit: pageSize,
  });
  const responseNextQuery = queries.at(-1);
  assert.equal(responseFirst.items.length, pageSize);
  assert.equal(responseFirst.nextCursor, 'rsvp-0500');
  assert.equal(responseSecond.items.length, pageSize);
  assert.equal(responseFirst.items[0]?.waMessageId, 'rsvp-0001');
  assert.equal(responseSecond.items[0]?.waMessageId, 'rsvp-0501');
  const responses = await collectResponses(responseFirst, responseSecond, listCapturedEventResponses);
  assert.equal(responses.length, messageCount);
  assert.equal(new Set(responses.map(item => item.waMessageId)).size, messageCount);
  assert.equal(responses.at(-1)?.waMessageId, 'rsvp-1201');
  assert.ok(!pins.some(item => item.key.id.includes('wrong-')));
  assert.ok(!responses.some(item => item.waMessageId.includes('wrong-')));

  await client.query('SET plan_cache_mode = force_generic_plan');
  const pinFirstPlan = await explainGeneric('pins_first_page', pinFirstQuery);
  const pinNextPlan = await explainGeneric('pins_next_page', pinNextQuery);
  const responseFirstPlan = await explainGeneric('responses_first_page', responseFirstQuery);
  const responseNextPlan = await explainGeneric('responses_next_page', responseNextQuery);
  for (const [name, plan, indexName] of [
    ['pins first', pinFirstPlan, 'idx_whatsapp_message_payloads_pins'],
    ['pins next', pinNextPlan, 'idx_whatsapp_message_payloads_pins'],
    ['RSVP first', responseFirstPlan, 'idx_whatsapp_message_payloads_event_responses'],
    ['RSVP next', responseNextPlan, 'idx_whatsapp_message_payloads_event_responses'],
  ]) {
    assert.ok(plan.includes(`using ${indexName}`), `${name} generic plan must use ${indexName}:\n${plan}`);
    assert.ok(plan.includes('Index Cond:'), `${name} generic plan must have an index condition:\n${plan}`);
    assert.ok(plan.includes('$1'), `${name} EXPLAIN should retain generic-plan parameter symbols:\n${plan}`);
  }
  for (const [name, plan, cursorParameter] of [
    ['pins next', pinNextPlan, '$3'],
    ['RSVP next', responseNextPlan, '$4'],
  ]) {
    const indexCondition = plan.split('\n').find(line => line.includes('Index Cond:')) || '';
    assert.ok(
      indexCondition.includes('wa_message_id') &&
        indexCondition.includes(' > ') &&
        indexCondition.includes(cursorParameter),
      `${name} cursor belongs in Index Cond:\n${plan}`
    );
  }
  for (const [name, plan] of [['pins first', pinFirstPlan], ['RSVP first', responseFirstPlan]]) {
    assert.ok(!plan.includes('wa_message_id COLLATE "C" >'), `${name} must omit the cursor predicate`);
  }

  console.log(`PostgreSQL ${process.env.PG_MAJOR || '17'}: 200000 ordinary + ${messageCount} pins + ${messageCount} RSVP rows`);
  console.log('Pagination: first, second and remaining pages return 1201 unique results per account/chat scope');
  console.log('Partial predicates: jsonb_path_exists is immutable; account/chat isolation passes');
  console.log('Generic EXPLAIN pins first page:\n' + pinFirstPlan);
  console.log('Generic EXPLAIN pins next page:\n' + pinNextPlan);
  console.log('Generic EXPLAIN RSVP first page:\n' + responseFirstPlan);
  console.log('Generic EXPLAIN RSVP next page:\n' + responseNextPlan);
} finally {
  pg.Pool.prototype.query = originalQuery;
  if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
  else process.env.CONNECTOR_ACCOUNT = previousAccount;
  await client.end();
}
