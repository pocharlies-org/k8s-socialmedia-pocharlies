/**
 * Unit tests for the Novedades store (SQL/parameter contract level). The
 * behavioral tests with real Postgres live in novedades-store.postgres.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import {
  NovedadesStoreError,
  NOVEDADES_STATUS_TTL_MS,
  ensureNovedadesTables,
  getNovedadesChannel,
  getNovedadesMessage,
  getNovedadesStatus,
  isNovedadesAuxiliaryMessage,
  isNovedadesChannelJid,
  listNovedadesChannels,
  listNovedadesMessages,
  listNovedadesStatus,
  listNovedadesStatusAuthors,
  markNovedadesMessageDeleted,
  markNovedadesStatusDeleted,
  novedadesContentVisibility,
  novedadesKind,
  novedadesMessageIdentity,
  novedadesStatusAuthor,
  normalizeNovedadesChannel,
  pruneExpiredNovedadesStatus,
  reconcileNovedadesMessageIds,
  storeNovedadesMessage,
  storeNovedadesStatus,
  upsertNovedadesChannel,
} from './novedades-store';

const CHANNEL = '120363123456789012@newsletter';
let bootstrapDdl = '';

interface StubResult {
  rows?: unknown[];
  rowCount?: number;
  error?: unknown;
}

function stubPool(
  script: StubResult[],
  options: { connect?: boolean; poolQuery?: boolean } = {}
): { calls: Array<{ sql: string; params: unknown[] }>; restore: () => void } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let index = 0;
  const run = (sql: unknown, params: unknown[] = []) => {
    calls.push({ sql: String(sql), params });
    const step = script[index++];
    if (!step) return Promise.resolve({ rows: [], rowCount: 0 });
    if (step.error) return Promise.reject(step.error);
    const rows = step.rows ?? [];
    return Promise.resolve({ rows, rowCount: step.rowCount ?? rows.length });
  };
  const originalQuery = pg.Pool.prototype.query as unknown;
  const originalConnect = pg.Pool.prototype.connect as unknown;
  const stubbed = { connect: false, query: false };
  if (options.connect) {
    stubbed.connect = true;
    (pg.Pool.prototype as { connect: unknown }).connect = async () => ({
      query: run,
      release: () => undefined,
    });
  }
  if (!options.connect || options.poolQuery) {
    stubbed.query = true;
    (pg.Pool.prototype as { query: unknown }).query = function (
      this: unknown,
      sql: unknown,
      params?: unknown[]
    ) {
      return run(sql, params);
    };
  }
  return {
    calls,
    restore: () => {
      if (stubbed.connect) (pg.Pool.prototype as { connect: unknown }).connect = originalConnect;
      if (stubbed.query) (pg.Pool.prototype as { query: unknown }).query = originalQuery;
    },
  };
}

function conflictSegment(sql: string): string {
  const marker = 'DO UPDATE SET';
  const start = sql.indexOf(marker);
  assert.notEqual(start, -1, 'sql should contain an upsert conflict clause');
  return sql.slice(
    start + marker.length,
    sql.indexOf('RETURNING') > start ? sql.indexOf('RETURNING') : undefined
  );
}

test('bootstrap holds one advisory-locked transaction and only creates Novedades tables', async () => {
  const { calls, restore } = stubPool([], { connect: true });
  try {
    await ensureNovedadesTables();
    await ensureNovedadesTables(); // second call is a no-op
    assert.equal(calls[0]!.sql, 'BEGIN');
    assert.match(calls[1]!.sql, /pg_advisory_xact_lock/);
    assert.deepEqual(calls[1]!.params, [20260927, 1]);
    const ddl = calls.map(call => call.sql).join('\n');
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS whatsapp_novedades_channels/);
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS whatsapp_novedades_messages/);
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS whatsapp_novedades_status/);
    assert.doesNotMatch(
      ddl,
      /whatsapp_message_payloads|conversations|(?<!\w)messages\s\(|\bALTER\b|\bDROP\b/i
    );
    assert.match(ddl, /WHERE server_id IS NOT NULL AND superseded_by IS NULL/);
    assert.match(ddl, /WHERE client_id IS NOT NULL AND superseded_by IS NULL/);
    assert.equal(calls.at(-1)!.sql, 'COMMIT');
    bootstrapDdl = ddl;
  } finally {
    restore();
  }
});

test('bootstrap columns keep visibility, soft-delete and honest freshness', () => {
  assert.match(bootstrapDdl, /message_type text,\s*visibility text NOT NULL DEFAULT 'unknown'/);
  const statusDdl = bootstrapDdl.slice(bootstrapDdl.indexOf('whatsapp_novedades_status ('));
  assert.match(statusDdl, /message_type text,\s*visibility text NOT NULL DEFAULT 'unknown'/);
  assert.match(statusDdl, /posted_at timestamptz,\s*expires_at timestamptz,/);
  assert.match(statusDdl, /is_deleted boolean NOT NULL DEFAULT false/);
  assert.match(bootstrapDdl, /superseded_by text/);
});

test('novedadesKind routes channel, status and null without heuristics', () => {
  assert.equal(novedadesKind({ remoteJid: CHANNEL }), 'channel');
  assert.equal(novedadesKind({ remoteJid: 'status@broadcast' }), 'status');
  assert.equal(novedadesKind({ remoteJid: '34600123456@s.whatsapp.net' }), null);
  assert.equal(novedadesKind({ remoteJid: '34600123456@c.us' }), null);
  assert.equal(isNovedadesChannelJid(`${CHANNEL}`), true);
  assert.equal(isNovedadesChannelJid('34600123456@s.whatsapp.net'), false);
});

test('identity resolution honors rc13 key.server_id and identityKind', () => {
  assert.deepEqual(novedadesMessageIdentity({ id: 'SRV1' }), {
    messageId: 'SRV1',
    serverId: 'SRV1',
    clientId: null,
  });
  assert.deepEqual(novedadesMessageIdentity({ id: 'CLI9', server_id: 'SRV9' }), {
    messageId: 'SRV9',
    serverId: 'SRV9',
    clientId: 'CLI9',
  });
  assert.deepEqual(novedadesMessageIdentity({ id: 'X', server_id: 'X' }), {
    messageId: 'X',
    serverId: 'X',
    clientId: null,
  });
  assert.deepEqual(novedadesMessageIdentity({ id: 'CLI2' }, 'client'), {
    messageId: 'CLI2',
    serverId: null,
    clientId: 'CLI2',
  });
  assert.throws(
    () => novedadesMessageIdentity({ id: ' ' }),
    (error: unknown) =>
      error instanceof NovedadesStoreError && error.code === 'INVALID_NOVEDADES_ID'
  );
});

test('store rejects non-channel JIDs, mismatched keys and blank ids before any query', async () => {
  const { calls, restore } = stubPool([]);
  try {
    await assert.rejects(
      storeNovedadesMessage({
        channelJid: '34600123456@s.whatsapp.net',
        key: { id: 'A', remoteJid: '34600123456@s.whatsapp.net' },
      }),
      (error: unknown) =>
        error instanceof NovedadesStoreError && error.code === 'INVALID_NOVEDADES_CHANNEL'
    );
    await assert.rejects(
      storeNovedadesMessage({ channelJid: CHANNEL, key: { id: 'A', remoteJid: '34600@s.us' } }),
      (error: unknown) =>
        error instanceof NovedadesStoreError && error.code === 'NOVEDADES_CHANNEL_MISMATCH'
    );
    await assert.rejects(
      storeNovedadesMessage({ channelJid: CHANNEL, key: { remoteJid: CHANNEL } }),
      (error: unknown) =>
        error instanceof NovedadesStoreError && error.code === 'INVALID_NOVEDADES_ID'
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('channel posts store raw ids with the account in its own column and visible classification', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool([{ rows: [{ message_id: 'SRV1' }] }]);
  try {
    const result = await storeNovedadesMessage({
      channelJid: CHANNEL,
      key: { id: 'SRV1', remoteJid: CHANNEL, participant: '34600@s.whatsapp.net' },
      message: { conversation: 'hola' },
      messageTimestampMs: 1_700_000_000_000,
    });
    assert.deepEqual(result, { matchedMessageId: 'SRV1', visibility: 'visible' });
    const insert = calls.find(call => /INSERT INTO whatsapp_novedades_messages/.test(call.sql))!;
    assert.ok(insert);
    assert.equal(insert.params[0], 'professional');
    assert.equal(insert.params[1], CHANNEL);
    assert.equal(insert.params[2], 'SRV1'); // raw, never accountKey-prefixed
    assert.equal(insert.params[3], 'SRV1'); // server_id
    assert.equal(insert.params[4], null); // client_id
    assert.equal(insert.params[5], null); // from_me unknown stays null (COALESCE in VALUES)
    assert.match(String(insert.params[6]), /34600@s\.whatsapp\.net/); // raw key preserved
    assert.equal(insert.params[9], 'conversation'); // message_type
    assert.equal(insert.params[10], 'visible'); // visibility
    assert.equal(insert.params[11], '34600@s.whatsapp.net'); // author
  } finally {
    restore();
  }
});

test('key.server_id becomes canonical id while key.id is kept as client_id', async () => {
  const { calls, restore } = stubPool([{ rows: [{ message_id: 'SRV9' }] }]);
  try {
    await storeNovedadesMessage({
      channelJid: CHANNEL,
      key: { id: 'CLI9', remoteJid: CHANNEL, fromMe: true, server_id: 'SRV9' },
      message: { conversation: 'post' },
    });
    const insert = calls[0]!;
    assert.equal(insert.params[2], 'SRV9');
    assert.equal(insert.params[3], 'SRV9');
    assert.equal(insert.params[4], 'CLI9');
    assert.equal(insert.params[5], true); // explicit fromMe true is present
  } finally {
    restore();
  }
});

test('identityKind client stores the id under client_id until reconciled', async () => {
  const { calls, restore } = stubPool([{ rows: [{ message_id: 'CLI2' }] }]);
  try {
    await storeNovedadesMessage({
      channelJid: CHANNEL,
      key: { id: 'CLI2', remoteJid: CHANNEL, fromMe: true },
      message: { imageMessage: { url: 'x' } },
      identityKind: 'client',
    });
    const insert = calls[0]!;
    assert.equal(insert.params[2], 'CLI2');
    assert.equal(insert.params[3], null);
    assert.equal(insert.params[4], 'CLI2');
  } finally {
    restore();
  }
});

test('redelivery merges keys and never loses from_me/visibility on payload-less ACKs', async () => {
  const { calls, restore } = stubPool([{ rows: [{ message_id: 'SRV1' }] }]);
  try {
    await storeNovedadesMessage({
      channelJid: CHANNEL,
      key: { id: 'SRV1', remoteJid: CHANNEL },
      message: { conversation: 'hola' },
    });
    const conflict = conflictSegment(calls[0]!.sql);
    assert.match(
      conflict,
      /whatsapp_novedades_messages\.message_key\s*\|\|\s*jsonb_strip_nulls\(EXCLUDED\.message_key\)/
    );
    assert.match(
      conflict,
      /from_me = COALESCE\(\$6::boolean, whatsapp_novedades_messages\.from_me\)/
    );
    assert.match(conflict, /visibility = CASE\s+WHEN EXCLUDED\.message_payload IS NOT NULL/);
    assert.doesNotMatch(conflict, /is_deleted/);
  } finally {
    restore();
  }
});

test('status upsert protects richer stored key and invented freshness stays impossible', async () => {
  const { calls, restore } = stubPool([{ rows: [{ wa_message_id: 'ST1' }] }]);
  try {
    await storeNovedadesStatus({
      key: { id: 'ST1', remoteJid: 'status@broadcast', participant: '34600@c.us' },
      message: { imageMessage: { caption: 'cumple' } },
      messageTimestampMs: 1_700_000_000_000,
    });
    const insert = calls[0]!;
    assert.equal(insert.params[1], '34600@s.whatsapp.net'); // normalized author
    assert.equal(insert.params[9], new Date(1_700_000_000_000).toISOString()); // posted_at
    assert.equal(
      insert.params[10],
      new Date(1_700_000_000_000 + NOVEDADES_STATUS_TTL_MS).toISOString()
    ); // expires_at = posted + 24h
    const conflict = conflictSegment(insert.sql);
    assert.match(conflict, /jsonb_strip_nulls\(EXCLUDED\.message_key\)/);
    assert.match(
      conflict,
      /posted_at = COALESCE\(whatsapp_novedades_status\.posted_at, EXCLUDED\.posted_at\)/
    );
    assert.doesNotMatch(conflict, /is_deleted/);
  } finally {
    restore();
  }
});

test('status without its timestamp is refused, or stored as freshness-unknown on request', async () => {
  const missing = stubPool([]);
  try {
    await assert.rejects(
      storeNovedadesStatus({
        key: { id: 'ST2', remoteJid: 'status@broadcast', participant: '34600@s.whatsapp.net' },
        message: { conversation: 'x' },
      }),
      (error: unknown) =>
        error instanceof NovedadesStoreError && error.code === 'NOVEDADES_STATUS_TIMESTAMP_REQUIRED'
    );
    assert.equal(missing.calls.length, 0, 'no Date.now fallback may write silently');
  } finally {
    missing.restore();
  }
  const { calls, restore } = stubPool([{ rows: [{ wa_message_id: 'ST2' }] }]);
  try {
    await storeNovedadesStatus({
      key: { id: 'ST2', remoteJid: 'status@broadcast', participant: '34600@s.whatsapp.net' },
      message: { conversation: 'x' },
      allowUnknownFreshness: true,
    });
    assert.equal(calls[0]!.params[9], null);
    assert.equal(calls[0]!.params[10], null);
  } finally {
    restore();
  }
});

test('own status author fallback requires fromMe and never mutates the stored key', async () => {
  assert.throws(
    () => novedadesStatusAuthor({ id: 'S', remoteJid: 'status@broadcast', fromMe: true }),
    (error: unknown) =>
      error instanceof NovedadesStoreError && error.code === 'NOVEDADES_STATUS_AUTHOR_REQUIRED'
  );
  assert.equal(
    novedadesStatusAuthor(
      { id: 'S', remoteJid: 'status@broadcast', fromMe: true },
      { ownJid: '34600@c.us' }
    ),
    '34600@s.whatsapp.net'
  );
  assert.throws(
    () =>
      novedadesStatusAuthor(
        { id: 'S', remoteJid: 'status@broadcast' },
        { ownJid: '34600@s.whatsapp.net' }
      ),
    (error: unknown) => error instanceof NovedadesStoreError
  );
  const key = { id: 'ST3', remoteJid: 'status@broadcast', fromMe: true };
  const { calls, restore } = stubPool([{ rows: [{ wa_message_id: 'ST3' }] }]);
  try {
    await storeNovedadesStatus({
      key,
      authorJid: '34600@s.whatsapp.net',
      message: { conversation: 'mío' },
      messageTimestampMs: 1_700_000_000_000,
    });
    assert.equal(calls[0]!.params[1], '34600@s.whatsapp.net');
    assert.deepEqual(JSON.parse(String(calls[0]!.params[3])), key); // raw key untouched
    assert.equal(calls[0]!.params[7], 'visible');
  } finally {
    restore();
  }
});

test('visibility classification: whitelist visible, three event kinds, unknown never visible', () => {
  const original = { ephemeralMessage: { message: { imageMessage: { url: 'u' } } } };
  const snapshot = JSON.parse(JSON.stringify(original));
  assert.deepEqual(novedadesContentVisibility({ conversation: 'hola' }), {
    visibility: 'visible',
    messageType: 'conversation',
  });
  assert.deepEqual(novedadesContentVisibility(original), {
    visibility: 'visible',
    messageType: 'imageMessage',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(original)), snapshot, 'classification is read-only');
  assert.deepEqual(
    novedadesContentVisibility({
      documentWithCaptionMessage: { message: { documentMessage: {} } },
    }),
    { visibility: 'visible', messageType: 'documentMessage' }
  );
  assert.deepEqual(novedadesContentVisibility({ reactionMessage: { text: '❤️' } }), {
    visibility: 'event',
    messageType: 'reactionMessage',
  });
  assert.deepEqual(novedadesContentVisibility({ protocolMessage: { type: 0 } }), {
    visibility: 'event',
    messageType: 'protocolMessage',
  });
  assert.deepEqual(novedadesContentVisibility({ senderKeyDistributionMessage: {} }), {
    visibility: 'event',
    messageType: 'senderKeyDistributionMessage',
  });
  assert.deepEqual(
    novedadesContentVisibility({
      conversation: 'primer contacto',
      senderKeyDistributionMessage: {},
    }),
    { visibility: 'visible', messageType: 'conversation' }
  );
  assert.equal(novedadesContentVisibility({ mensajeDelFuturoMessage: {} }).visibility, 'unknown');
  assert.equal(novedadesContentVisibility(undefined).visibility, 'unknown');
  assert.equal(isNovedadesAuxiliaryMessage({ reactionMessage: {} }), true);
  assert.equal(
    isNovedadesAuxiliaryMessage({ ephemeralMessage: { message: { protocolMessage: {} } } }),
    true
  );
  assert.equal(isNovedadesAuxiliaryMessage({ conversation: 'hola' }), false);
});

test('store converts a server-id collision into an in-place live refresh', async () => {
  const violation = Object.assign(new Error('duplicate key'), { code: '23505' });
  const { calls, restore } = stubPool([
    { error: violation },
    { rows: [{ message_id: 'CLI-1' }], rowCount: 1 },
  ]);
  try {
    const result = await storeNovedadesMessage({
      channelJid: CHANNEL,
      key: { id: 'SRV1', remoteJid: CHANNEL, fromMe: true, server_id: 'SRV1' },
      message: { conversation: 'confirmado' },
    });
    assert.deepEqual(result, { matchedMessageId: 'CLI-1', visibility: 'visible' });
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.sql, /UPDATE whatsapp_novedades_messages/);
    assert.match(calls[1]!.sql, /server_id = \$13/);
    assert.match(calls[1]!.sql, /superseded_by IS NULL/);
  } finally {
    restore();
  }
});

test('store reports an honest identity conflict when no live row can absorb the id', async () => {
  const violation = Object.assign(new Error('duplicate key'), { code: '23505' });
  const { restore } = stubPool([{ error: violation }, { rowCount: 0 }, { rowCount: 0 }]);
  try {
    await assert.rejects(
      storeNovedadesMessage({
        channelJid: CHANNEL,
        key: { id: 'SRV1', remoteJid: CHANNEL },
        message: { conversation: 'x' },
      }),
      (error: unknown) =>
        error instanceof NovedadesStoreError && error.code === 'NOVEDADES_IDENTITY_CONFLICT'
    );
  } finally {
    restore();
  }
});

test('a client id confirmed by the server collapses the duplicate atomically', async () => {
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const aliasConflict = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "whatsapp_novedades_messages_client_uidx"'
    ),
    { code: '23505', constraint: 'whatsapp_novedades_messages_client_uidx' }
  );
  const serverRow = {
    message_id: 'SRV-9',
    server_id: 'SRV-9',
    client_id: null,
    metadata: { src: 'server' },
    is_deleted: false,
    deleted_at: null,
    from_me: false,
  };
  const clientRow = {
    message_id: 'CLI-9',
    server_id: null,
    client_id: 'CLI-9',
    metadata: { src: 'client' },
    is_deleted: true,
    deleted_at: new Date('2026-01-01T00:00:00.000Z'),
    from_me: true,
  };
  const { calls, restore } = stubPool(
    [
      { rows: [{ message_id: 'CLI-9' }] }, // 1. own post stored under the local id
      { rows: [{ message_id: 'SRV-9' }] }, // 2. server id arrives: second live row
      { error: aliasConflict }, // 3. both ids: client_uidx says "already held"
      {}, // BEGIN of the atomic collapse
      { rows: [serverRow] }, // canonical row lock
      { rows: [clientRow] }, // alias holder lock
      { rows: [], rowCount: 1 }, // archive the client duplicate
      { rows: [], rowCount: 1 }, // survivor claims both ids
      { rows: [{ message_id: 'SRV-9' }] }, // merge this event into the survivor
      {}, // COMMIT
    ],
    { connect: true, poolQuery: true }
  );
  try {
    assert.deepEqual(
      await storeNovedadesMessage({
        channelJid: CHANNEL,
        key: { id: 'CLI-9', remoteJid: CHANNEL, fromMe: true },
        message: { conversation: 'borrador' },
        identityKind: 'client',
      }),
      { matchedMessageId: 'CLI-9', visibility: 'visible' }
    );
    assert.deepEqual(
      await storeNovedadesMessage({
        channelJid: CHANNEL,
        key: { id: 'SRV-9', remoteJid: CHANNEL },
        message: { conversation: 'publicado' },
      }),
      { matchedMessageId: 'SRV-9', visibility: 'visible' }
    );
    const confirmed = {
      channelJid: CHANNEL,
      key: { id: 'CLI-9', remoteJid: CHANNEL, server_id: 'SRV-9' },
      message: { conversation: 'publicado' },
    };
    assert.deepEqual(await storeNovedadesMessage(confirmed), {
      matchedMessageId: 'SRV-9',
      visibility: 'visible',
    });
    const statements = calls.map(call => call.sql.replace(/\s+/g, ' ').trim());
    assert.match(statements[0]!, /^INSERT INTO whatsapp_novedades_messages/);
    assert.match(statements[1]!, /^INSERT INTO whatsapp_novedades_messages/);
    assert.equal(statements[3], 'BEGIN');
    assert.match(statements[4]!, /FOR UPDATE/);
    assert.equal(
      (statements[4]!.match(/\$3/g) ?? []).length,
      4,
      'one locked lookup by any known id'
    );
    assert.match(statements[5]!, /FOR UPDATE/);
    assert.match(statements[6]!, /SET superseded_by = \$4/);
    assert.match(
      statements[6]!,
      /metadata \|\| jsonb_build_object\('reconciled_into', \$5::text\)/
    );
    assert.match(statements[6]!, /message_id = \$3/);
    assert.deepEqual(calls[6]!.params, ['personal', CHANNEL, 'CLI-9', 'SRV-9', 'SRV-9']);
    assert.match(statements[7]!, /SET server_id = COALESCE\(server_id, \$3\)/);
    assert.match(statements[7]!, /from_me = from_me OR COALESCE\(\$8::boolean, false\)/);
    assert.match(statements[7]!, /message_id = \$9/);
    assert.match(statements[8]!, /^UPDATE whatsapp_novedades_messages/);
    assert.match(statements[8]!, /client_id = COALESCE\(\$8, client_id\)/);
    assert.match(statements[8]!, /message_id = \$13/);
    assert.match(statements[8]!, /superseded_by IS NULL/);
    assert.equal(calls[8]!.params[7], 'CLI-9', 'the confirmed client alias is claimed');
    assert.doesNotMatch(statements[8]!, /is_deleted/);
    assert.equal(statements[9], 'COMMIT');
    const all = statements.join('\n');
    assert.doesNotMatch(all, /DELETE FROM whatsapp_novedades_messages/i);
    assert.ok(
      statements.indexOf('BEGIN') < statements.indexOf(statements[6]!) &&
        statements.indexOf(statements[6]!) < statements.indexOf(statements[8]!),
      'the alias is released before the survivor claims it and before the merge'
    );

    restore();
    const after = stubPool([{ rows: [{ message_id: 'SRV-9' }] }]);
    try {
      assert.deepEqual(await storeNovedadesMessage(confirmed), {
        matchedMessageId: 'SRV-9',
        visibility: 'visible',
      });
      assert.equal(
        after.calls.length,
        1,
        'the collapsed key must not take the conflict path again'
      );
      assert.match(after.calls[0]!.sql, /^INSERT INTO whatsapp_novedades_messages/);
    } finally {
      after.restore();
    }
  } finally {
    restore();
  }
});

test('a mid-flight claim collision is retried once and never escapes as a raw 23505', async () => {
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const aliasConflict = Object.assign(new Error('duplicate key'), {
    code: '23505',
    constraint: 'whatsapp_novedades_messages_client_uidx',
  });
  const serverRow = {
    message_id: 'SRV-10',
    server_id: 'SRV-10',
    client_id: null,
    metadata: {},
    is_deleted: false,
    deleted_at: null,
    from_me: false,
  };
  const clientRow = {
    message_id: 'CLI-10',
    server_id: null,
    client_id: 'CLI-10',
    metadata: {},
    is_deleted: false,
    deleted_at: null,
    from_me: null,
  };
  const collapsing = [
    { error: aliasConflict }, // INSERT hits the alias index
    {}, // BEGIN (attempt 1)
    { rows: [serverRow] },
    { rows: [clientRow] },
    { rows: [], rowCount: 1 }, // archive
    { error: aliasConflict }, // a concurrent ingest claimed it first
    {}, // ROLLBACK
    {}, // BEGIN (attempt 2)
    { rows: [serverRow] },
    { rows: [clientRow] },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [{ message_id: 'SRV-10' }] },
    {}, // COMMIT
  ];
  const { calls, restore } = stubPool(collapsing, { connect: true, poolQuery: true });
  const confirmed = {
    channelJid: CHANNEL,
    key: { id: 'CLI-10', remoteJid: CHANNEL, server_id: 'SRV-10' },
    message: { conversation: 'publicado' },
  };
  try {
    assert.deepEqual(await storeNovedadesMessage(confirmed), {
      matchedMessageId: 'SRV-10',
      visibility: 'visible',
    });
    const verbs = calls.map(call => call.sql.trim().split(/\s+/)[0].toUpperCase());
    assert.deepEqual(verbs.slice(1, 14), [
      'BEGIN',
      'SELECT',
      'SELECT',
      'UPDATE',
      'UPDATE',
      'ROLLBACK',
      'BEGIN',
      'SELECT',
      'SELECT',
      'UPDATE',
      'UPDATE',
      'UPDATE',
      'COMMIT',
    ]);
  } finally {
    restore();
  }

  const stillStuck = [
    { error: aliasConflict },
    {}, // BEGIN (attempt 1)
    { rows: [serverRow] },
    { rows: [clientRow] },
    { rows: [], rowCount: 1 },
    { error: aliasConflict },
    {}, // ROLLBACK
    {}, // BEGIN (attempt 2)
    { rows: [serverRow] },
    { rows: [clientRow] },
    { rows: [], rowCount: 1 },
    { error: aliasConflict },
    {}, // ROLLBACK
    { error: aliasConflict }, // in-place refresh still collides
  ];
  const stuck = stubPool(stillStuck, { connect: true, poolQuery: true });
  try {
    await assert.rejects(
      storeNovedadesMessage(confirmed),
      (error: unknown) =>
        error instanceof NovedadesStoreError &&
        error.code === 'NOVEDADES_IDENTITY_CONFLICT' &&
        error.status === 409 &&
        /whatsapp_novedades_messages_client_uidx/.test(error.message),
      'a residual collision must be a wrapped 409, never a bare driver error'
    );
  } finally {
    stuck.restore();
  }
});

test('reads scope to account+channel, live rows and visible content by default', async () => {
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const { calls, restore } = stubPool([{ rows: [] }]);
  try {
    await listNovedadesMessages(CHANNEL, { beforeTimestampMs: 1_700_000_001_000 });
    const sql = calls[0]!.sql;
    assert.match(sql, /account = \$1 AND channel_jid = \$2/);
    assert.match(sql, /NOT is_deleted/);
    assert.match(sql, /superseded_by IS NULL/);
    assert.match(sql, /visibility = \$4/);
    assert.equal(calls[0]!.params[0], 'personal');
    await listNovedadesMessages(CHANNEL, {
      visibility: 'all',
      includeDeleted: true,
      includeSuperseded: true,
    });
    const wide = calls[1]!.sql;
    assert.doesNotMatch(wide, /visibility = /);
    assert.doesNotMatch(wide, /NOT is_deleted/);
    assert.doesNotMatch(wide, /superseded_by IS NULL/);
  } finally {
    restore();
  }
});

test('getNovedadesMessage resolves any known id and revives nothing physically', async () => {
  const storedKey = { id: 'M1', remoteJid: CHANNEL, participant: '34600@s.whatsapp.net' };
  const { calls, restore } = stubPool([
    {
      rows: [
        {
          account: 'personal',
          channel_jid: CHANNEL,
          message_id: 'M1',
          server_id: 'M1',
          client_id: null,
          superseded_by: null,
          from_me: false,
          message_key: storedKey,
          message_payload: { __socialmedia_type: 'Uint8Array', value: 'AAEC' },
          message_timestamp_ms: '1700000000000',
          message_type: 'conversation',
          visibility: 'visible',
          author_jid: null,
          metadata: {},
          is_deleted: false,
          deleted_at: null,
          created_at: new Date(0),
          updated_at: new Date(0),
        },
      ],
    },
  ]);
  try {
    const found = await getNovedadesMessage(CHANNEL, 'M1');
    assert.ok(found);
    assert.equal(found.messageId, 'M1');
    assert.deepEqual(found.key, storedKey);
    assert.ok(found.payload instanceof Uint8Array, 'durable bytes round-trip');
    assert.deepEqual([...(found.payload as Uint8Array)], [0, 1, 2]);
    assert.match(calls[0]!.sql, /message_id = \$3 OR server_id = \$3 OR client_id = \$3/);
    assert.match(calls[0]!.sql, /superseded_by IS NULL/);
    await getNovedadesMessage(CHANNEL, 'M1', { includeSuperseded: true });
    assert.doesNotMatch(calls[1]!.sql, /superseded_by IS NULL/);
  } finally {
    restore();
  }
});

test('channel revokes soft-delete or insert an honest tombstone but never delete', async () => {
  const { calls, restore } = stubPool([{}, { rowCount: 1 }, {}], { connect: true });
  try {
    const existing = await markNovedadesMessageDeleted(CHANNEL, 'SRV5');
    assert.deepEqual(existing, { marked: true, createdTombstone: false });
    assert.match(calls[1]!.sql, /UPDATE whatsapp_novedades_messages/);
    assert.match(calls[1]!.sql, /is_deleted = \$4::boolean/);
  } finally {
    restore();
  }
  const tomb = stubPool(
    [
      {}, // BEGIN
      { rowCount: 0 }, // UPDATE matched nothing (revoke arrived before the post)
      { rows: [], rowCount: 1 }, // tombstone insert
      {}, // COMMIT
    ],
    { connect: true }
  );
  try {
    const result = await markNovedadesMessageDeleted(CHANNEL, 'SRV6');
    assert.deepEqual(result, { marked: true, createdTombstone: true });
    const insert = tomb.calls.find(call =>
      /INSERT INTO whatsapp_novedades_messages/.test(call.sql)
    )!;
    assert.ok(insert);
    assert.match(insert.sql, /'{"tombstone": true}'::jsonb/);
    assert.deepEqual(JSON.parse(String(insert.params[3])), {
      id: 'SRV6',
      remoteJid: CHANNEL,
      tombstone: true,
    });
    assert.ok(
      tomb.calls.every(call => !/DELETE FROM/i.test(call.sql)),
      'no physical delete'
    );
  } finally {
    tomb.restore();
  }
});

test('status deletion hides, tombstones unknown status ids, and never deletes rows', async () => {
  const author = '34600123456@s.whatsapp.net';
  const existing = stubPool([{}, { rowCount: 1 }, {}], { connect: true });
  try {
    const result = await markNovedadesStatusDeleted({
      authorJid: '34600123456@c.us',
      messageId: 'ST9',
    });
    assert.deepEqual(result, { marked: true, createdTombstone: false });
    assert.equal(existing.calls[1]!.params[1], author);
  } finally {
    existing.restore();
  }
  const tomb = stubPool([{}, { rowCount: 0 }, { rows: [], rowCount: 1 }, {}], { connect: true });
  try {
    const result = await markNovedadesStatusDeleted({ authorJid: author, messageId: 'ST10' });
    assert.deepEqual(result, { marked: true, createdTombstone: true });
    const insert = tomb.calls.find(call => /INSERT INTO whatsapp_novedades_status/.test(call.sql))!;
    assert.ok(insert);
    assert.deepEqual(JSON.parse(String(insert.params[3])), {
      id: 'ST10',
      remoteJid: 'status@broadcast',
      tombstone: true,
    });
    assert.ok(tomb.calls.every(call => !/DELETE FROM/i.test(call.sql)));
  } finally {
    tomb.restore();
  }
});

test('status reads hide expired/unknown/event/seen states behind explicit options', async () => {
  const { calls, restore } = stubPool([{ rows: [] }]);
  try {
    await listNovedadesStatus({ authorJids: ['34600123456@c.us'] });
    const sql = calls[0]!.sql;
    assert.match(sql, /expires_at > now\(\)/);
    assert.match(sql, /NOT is_deleted/);
    assert.match(sql, /visibility = \$3/);
    assert.deepEqual(calls[0]!.params[1], ['34600123456@s.whatsapp.net']);
    assert.equal(calls[0]!.params[2], 'visible');
    await listNovedadesStatus({ includeExpired: true, includeDeleted: true, visibility: 'all' });
    assert.doesNotMatch(calls[1]!.sql, /expires_at > now\(\)/);
    assert.doesNotMatch(calls[1]!.sql, /NOT is_deleted/);
    assert.doesNotMatch(calls[1]!.sql, /visibility = /);
    await listNovedadesStatusAuthors();
    assert.match(calls[2]!.sql, /visibility = 'visible'/);
    assert.match(calls[2]!.sql, /NOT is_deleted/);
  } finally {
    restore();
  }
});

test('author rollup names the newest status and keeps its arrival watermark exact', async () => {
  const { calls, restore } = stubPool([
    {
      rows: [
        {
          author_jid: '34600123456@s.whatsapp.net',
          total: 2,
          active: 2,
          unseen: 1,
          latest_posted_at: new Date('2026-09-28T10:00:00.000Z'),
          latest_status_id: 'ST-TIE-AAA',
          latest_received_at: '2026-09-28T10:00:00.000002Z',
        },
        { author_jid: '34600000009@s.whatsapp.net', total: 1, active: 0, unseen: 0 },
      ],
    },
  ]);
  try {
    const summaries = await listNovedadesStatusAuthors();
    const sql = calls[0]!.sql;
    // Posting time, then arrival, then id: one total order drives both new
    // columns, so the id and the watermark can never describe different rows.
    assert.equal(
      (sql.match(/ORDER BY posted_at DESC NULLS LAST, created_at DESC, wa_message_id DESC/g) ?? [])
        .length,
      2,
      'identity and watermark must share a single tie-break order'
    );
    assert.match(sql, /\)\[1\] AS latest_status_id/);
    // Microseconds come from SQL, not from a JS Date, which would collapse them.
    assert.match(
      sql,
      /to_char\([\s\S]*AT TIME ZONE 'UTC',\s*'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'/
    );
    assert.match(sql, /MAX\(posted_at\) AS latest_posted_at/);
    assert.equal(summaries.length, 1, 'expired-only author stays hidden');
    assert.deepEqual(summaries[0], {
      authorJid: '34600123456@s.whatsapp.net',
      total: 2,
      active: 2,
      unseen: 1,
      latestPostedAt: '2026-09-28T10:00:00.000Z',
      latestStatusId: 'ST-TIE-AAA',
      // Passed through verbatim: `...000Z` here would mean the microseconds were lost.
      latestReceivedAt: '2026-09-28T10:00:00.000002Z',
    });
  } finally {
    restore();
  }
});

test('prune only clears expired known-freshness statuses with an explicit now', async () => {
  const now = new Date(1_700_000_000_000);
  const { calls, restore } = stubPool([{ rows: [1, 2], rowCount: 2 }]);
  try {
    const result = await pruneExpiredNovedadesStatus({ now, graceMs: 60_000 });
    assert.deepEqual(result, { deleted: 2 });
    assert.match(calls[0]!.sql, /^DELETE FROM whatsapp_novedades_status$/m);
    assert.match(calls[0]!.sql, /expires_at IS NOT NULL/);
    assert.equal(calls[0]!.params[1], now.toISOString());
    assert.equal(calls[0]!.params[2], 60_000);
  } finally {
    restore();
  }
});

test('reconcile early-returns equal ids and reports not_found with row locks', async () => {
  const same = stubPool([]);
  try {
    assert.deepEqual(
      await reconcileNovedadesMessageIds({ channelJid: CHANNEL, clientId: 'X', serverId: 'X' }),
      {
        status: 'updated',
        messageId: 'X',
      }
    );
    assert.equal(same.calls.length, 0);
  } finally {
    same.restore();
  }
  const { calls, restore } = stubPool(
    [{}, { rows: [] }, { rows: [] }, {}], // BEGIN, server lookup, client lookup, COMMIT
    { connect: true }
  );
  try {
    const result = await reconcileNovedadesMessageIds({
      channelJid: CHANNEL,
      clientId: 'CLI-1',
      serverId: 'SRV-1',
    });
    assert.deepEqual(result, { status: 'not_found' });
    assert.equal(calls[0]!.sql, 'BEGIN');
    assert.match(calls[1]!.sql, /FOR UPDATE/);
    assert.match(calls[1]!.sql, /superseded_by IS NULL/);
    assert.match(calls.at(-1)!.sql, /COMMIT/);
  } finally {
    restore();
  }
});

test('reconcile moves a lone client row to the server id and keeps client_id', async () => {
  const { calls, restore } = stubPool(
    [
      {}, // BEGIN
      { rows: [] }, // server lookup: none yet
      { rows: [{ message_id: 'CLI-1', metadata: {}, is_deleted: false }] }, // client lookup
      { rows: [{ message_id: 'SRV-1' }] }, // move UPDATE
      {}, // COMMIT
    ],
    { connect: true }
  );
  try {
    const result = await reconcileNovedadesMessageIds({
      channelJid: CHANNEL,
      clientId: 'CLI-1',
      serverId: 'SRV-1',
    });
    assert.deepEqual(result, { status: 'updated', messageId: 'SRV-1' });
    const move = calls.find(call => /SET message_id = \$4/.test(call.sql))!;
    assert.ok(move);
    assert.equal(move.params[3], 'SRV-1');
    assert.equal(move.params[4], 'CLI-1');
    assert.ok(calls.every(call => !/DELETE FROM/i.test(call.sql)));
  } finally {
    restore();
  }
});

test('reconcile archives the client duplicate without losing payload or flags', async () => {
  const deletedAt = new Date(1_700_000_100_000);
  const { calls, restore } = stubPool(
    [
      {}, // BEGIN
      { rows: [{ message_id: 'SRV-7', metadata: { src: 'server' }, is_deleted: false }] },
      {
        rows: [
          {
            message_id: 'CLI-7',
            client_id: 'CLI-7',
            metadata: { src: 'client', draft: true },
            is_deleted: true,
            deleted_at: deletedAt,
            from_me: true,
          },
        ],
      },
      {}, // archive UPDATE (client -> superseded_by)
      {}, // claim UPDATE (server absorbs ids/flags)
      {}, // COMMIT
    ],
    { connect: true }
  );
  try {
    const result = await reconcileNovedadesMessageIds({
      channelJid: CHANNEL,
      clientId: 'CLI-7',
      serverId: 'SRV-7',
    });
    assert.deepEqual(result, { status: 'updated', messageId: 'SRV-7', mergedDuplicate: true });
    const archive = calls.find(call => /SET superseded_by = \$4/.test(call.sql))!;
    assert.ok(archive, 'client row must be archived first so the unique alias frees up');
    assert.equal(archive.params[2], 'CLI-7');
    assert.equal(archive.params[3], 'SRV-7');
    assert.match(archive.sql, /jsonb_build_object\('reconciled_into', \$5::text\)/);
    const claim = calls.find(call => /SET server_id = COALESCE\(server_id, \$3\)/.test(call.sql))!;
    assert.ok(claim);
    assert.equal(claim.params[2], 'SRV-7'); // serverId
    assert.equal(claim.params[3], 'CLI-7'); // claimed client_id
    assert.equal(claim.params[4], JSON.stringify({ src: 'client', draft: true }));
    assert.equal(claim.params[5], true); // is_deleted OR
    assert.equal(claim.params[6], deletedAt.toISOString());
    assert.equal(claim.params[7], true); // from_me OR
    assert.equal(claim.params[8], 'SRV-7');
    assert.match(claim.sql, /metadata = jsonb_strip_nulls\(\$5::jsonb\) \|\| metadata/);
    assert.ok(
      calls.every(call => !/DELETE FROM/i.test(call.sql)),
      'merge never physically deletes'
    );
  } finally {
    restore();
  }
});

test('channel directory stores normalized metadata and preserves the provider object', async () => {
  const metadata = {
    id: CHANNEL,
    name: 'Canal Oficial',
    description: 'desc',
    owner: '34600@s.whatsapp.net',
    subscribers: 10,
    creation_time: 1_600_000_000,
    picture: { url: 'https://example/p.jpg' },
    invite: { code: 'ABC' },
    verification: 'VERIFIED',
    mute_state: 'OFF',
  };
  const normalized = normalizeNovedadesChannel(metadata, { role: 'SUBSCRIBER' });
  assert.equal(normalized.jid, CHANNEL);
  assert.equal(normalized.creationTimestampMs, 1_600_000_000_000);
  assert.equal(normalized.avatarUrl, 'https://example/p.jpg');
  assert.equal(normalized.inviteCode, 'ABC');
  assert.equal(normalized.subscriberCount, 10);
  assert.equal(normalized.rawMetadata, metadata, 'raw preserved by reference');
  assert.throws(
    () => normalizeNovedadesChannel({ id: '34600@s.whatsapp.net', name: 'nope' }),
    (error: unknown) =>
      error instanceof NovedadesStoreError && error.code === 'INVALID_NOVEDADES_CHANNEL'
  );
  const { calls, restore } = stubPool([{}]);
  try {
    await upsertNovedadesChannel(normalized);
    assert.equal(calls[0]!.params[0], 'personal');
    assert.equal(calls[0]!.params[2], 'Canal Oficial');
    assert.deepEqual(JSON.parse(String(calls[0]!.params[12])), metadata);
  } finally {
    restore();
  }
  const { calls: listCalls, restore: restoreList } = stubPool([
    {
      rows: [
        {
          account: 'personal',
          channel_jid: CHANNEL,
          name: 'Canal Oficial',
          subscriber_count: '10',
          creation_timestamp_ms: '1600000000000',
          raw_metadata: metadata,
        },
      ],
    },
  ]);
  try {
    const [row] = await listNovedadesChannels();
    assert.ok(row);
    assert.equal(row.subscriberCount, 10);
    assert.equal(row.creationTimestampMs, 1_600_000_000_000);
    assert.deepEqual(row.rawMetadata, metadata);
  } finally {
    restoreList();
  }
  assert.equal(listCalls[0]!.params[0], 'personal');
});

test('status paging keys on exact epoch milliseconds with an id tie-breaker', async () => {
  const { calls, restore } = stubPool([{ rows: [] }, { rows: [] }]);
  try {
    await listNovedadesStatus({ after: { timestampMs: 1_700_000_000_000, id: 'ST-9' } });
    const sql = calls[0]!.sql;
    assert.match(sql, /message_timestamp_ms < \$2::bigint/);
    assert.match(sql, /\(message_timestamp_ms = \$2::bigint AND wa_message_id < \$3\)/);
    assert.match(sql, /ORDER BY message_timestamp_ms DESC NULLS LAST, wa_message_id DESC/);
    assert.doesNotMatch(sql, /posted_at/);
    assert.deepEqual(calls[0]!.params.slice(1, 3), [1_700_000_000_000, 'ST-9']);
    // A null keyset timestamp means the "no posting time" tail, not "everything".
    await listNovedadesStatus({ after: { timestampMs: null, id: 'ST-9' } });
    assert.match(
      calls[1]!.sql,
      /WHEN \$2::bigint IS NULL\s+THEN \(message_timestamp_ms IS NULL AND wa_message_id < \$3\)/
    );
    assert.equal(calls[1]!.params[1], null);
  } finally {
    restore();
  }
  const { calls: badCalls, restore: restoreBad } = stubPool([]);
  try {
    for (const bad of [0, -5, 12.5, Number.MAX_SAFE_INTEGER + 1, 'soon']) {
      await assert.rejects(
        () => listNovedadesStatus({ after: { timestampMs: bad as number, id: 'ST-1' } }),
        (error: unknown) =>
          error instanceof NovedadesStoreError && error.code === 'INVALID_NOVEDADES_INPUT'
      );
    }
    assert.equal(badCalls.length, 0);
  } finally {
    restoreBad();
  }
});

test('post paging keys on the same timestamp column the page is sorted by', async () => {
  const { calls, restore } = stubPool([{ rows: [] }, { rows: [] }]);
  try {
    await listNovedadesMessages(CHANNEL, {
      after: { timestampMs: 1_700_000_000_000, id: 'P-9' },
    });
    const sql = calls[0]!.sql;
    assert.match(sql, /message_timestamp_ms < \$3::bigint/);
    assert.match(sql, /\(message_timestamp_ms = \$3::bigint AND message_id < \$4\)/);
    assert.match(sql, /ORDER BY message_timestamp_ms DESC NULLS LAST, message_id DESC/);
    assert.deepEqual(calls[0]!.params.slice(2, 4), [1_700_000_000_000, 'P-9']);
    await listNovedadesMessages(CHANNEL, { after: { timestampMs: null, id: 'P-9' } });
    assert.match(calls[1]!.sql, /THEN \(message_timestamp_ms IS NULL AND message_id < \$4\)/);
  } finally {
    restore();
  }
});

test('channel paging sorts by name then jid so equal names still advance', async () => {
  const { calls, restore } = stubPool([{ rows: [] }]);
  try {
    await listNovedadesChannels({ limit: 25, after: { name: 'Canal', jid: CHANNEL } });
    assert.match(
      calls[0]!.sql,
      /AND \(lower\(name\) > \$2 OR \(lower\(name\) = \$2 AND channel_jid > \$3\)\)/
    );
    assert.match(calls[0]!.sql, /ORDER BY lower\(name\), channel_jid/);
    assert.deepEqual(calls[0]!.params, ['personal', 'canal', CHANNEL, 25]);
  } finally {
    restore();
  }
});

test('one channel is read exactly by account and jid, never by scanning a page', async () => {
  const { calls, restore } = stubPool([
    {
      rows: [
        {
          account: 'personal',
          channel_jid: CHANNEL,
          name: 'Canal Oficial',
          role: 'admin',
          avatar_url: 'https://pps.whatsapp.net/v/t6/avatar.jpg',
          subscriber_count: '10',
          creation_timestamp_ms: '1600000000000',
          mute_state: 'none',
          raw_metadata: { source: 'test' },
        },
      ],
    },
  ]);
  try {
    const row = await getNovedadesChannel(CHANNEL);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /WHERE account = \$1 AND channel_jid = \$2 LIMIT 1/);
    assert.deepEqual(calls[0]!.params, ['personal', CHANNEL]);
    assert.equal(row?.jid, CHANNEL);
    assert.equal(row?.role, 'admin');
    assert.equal(row?.subscriberCount, 10);
    assert.equal(row?.creationTimestampMs, 1_600_000_000_000);
    assert.deepEqual(row?.rawMetadata, { source: 'test' });
  } finally {
    restore();
  }
  const { calls: rejected, restore: restoreRejected } = stubPool([]);
  try {
    await assert.rejects(
      () => getNovedadesChannel('34600123456@s.whatsapp.net'),
      (error: unknown) =>
        error instanceof NovedadesStoreError && error.code === 'INVALID_NOVEDADES_CHANNEL'
    );
    assert.equal(rejected.length, 0);
  } finally {
    restoreRejected();
  }
});

test('one status is read exactly by account, author and id with conservative defaults', async () => {
  const posted = new Date(1_700_000_000_000);
  const { calls, restore } = stubPool([
    {
      rows: [
        {
          account: 'personal',
          author_jid: '34600123456@s.whatsapp.net',
          wa_message_id: 'ST-1',
          message_key: {
            id: 'ST-1',
            remoteJid: 'status@broadcast',
            participant: '34600123456@s.whatsapp.net',
          },
          message_payload: { conversation: 'hola' },
          message_timestamp_ms: '1700000000000',
          message_type: 'conversation',
          visibility: 'visible',
          metadata: {},
          posted_at: posted,
          expires_at: new Date(Date.now() + 3_600_000),
          is_deleted: false,
        },
      ],
    },
    { rows: [] },
  ]);
  try {
    const row = await getNovedadesStatus('34600123456@c.us', 'ST-1');
    const sql = calls[0]!.sql;
    assert.match(sql, /account = \$1 AND author_jid = \$2 AND wa_message_id = \$3/);
    assert.match(sql, /expires_at > now\(\)/);
    assert.match(sql, /NOT is_deleted/);
    assert.match(sql, /visibility = \$4/);
    assert.match(sql, /LIMIT 1/);
    assert.deepEqual(calls[0]!.params, [
      'personal',
      '34600123456@s.whatsapp.net',
      'ST-1',
      'visible',
    ]);
    assert.equal(row?.messageId, 'ST-1');
    assert.equal(row?.active, true);
    assert.equal(row?.timestampMs, 1_700_000_000_000);
    const missing = await getNovedadesStatus('34600123456@s.whatsapp.net', 'ST-404', {
      includeExpired: true,
      includeDeleted: true,
      visibility: 'all',
    });
    assert.equal(missing, undefined);
    assert.doesNotMatch(calls[1]!.sql, /expires_at > now\(\)/);
    assert.doesNotMatch(calls[1]!.sql, /NOT is_deleted/);
    assert.doesNotMatch(calls[1]!.sql, /visibility = /);
    assert.equal(calls[1]!.params.length, 3);
  } finally {
    restore();
  }
  const { calls: rejected, restore: restoreRejected } = stubPool([]);
  try {
    await assert.rejects(
      () => getNovedadesStatus('120363123456789012@g.us', 'ST-1'),
      (error: unknown) =>
        error instanceof NovedadesStoreError && error.code === 'INVALID_NOVEDADES_AUTHOR'
    );
    assert.equal(rejected.length, 0);
  } finally {
    restoreRejected();
  }
});
