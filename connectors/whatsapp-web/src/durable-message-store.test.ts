import { assertDenseParameters } from './test-support/sql-parameters';
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proto } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import pg from 'pg';
import {
  ensureDurableTables,
  adoptPayloadTimestampShape,
  resetDurableStoreStateForTests,
  deserializeDurableValue,
  fromDurablePayload,
  serializeDurableValue,
  shouldStoreDurablePayload,
  toDurablePayload,
  unixSeconds,
  getMessageKeysForChat,
  listStoredContacts,
  markMessageDeleted,
  markMessageEdited,
  listCapturedPollUpdates,
  storeContact,
  storeMessageReaction,
  storeRawWAMessage,
  getRawWAMessage,
  listCapturedEventResponses,
  EVENT_RESPONSE_PRESENT_SQL,
  PIN_ACTION_SQL,
  PAYLOAD_PARTIAL_INDEX_DDL,
  upsertChatState,
} from './durable-message-store';

test('durable table bootstrap holds one transaction advisory lock on a dedicated client', async () => {
  const calls: string[] = [];
  const original = pg.Pool.prototype.connect;
  (pg.Pool.prototype as any).connect = async () => ({
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [] };
    },
    release: () => {
      calls.push('RELEASE');
    },
  });
  try {
    await ensureDurableTables();
    assert.equal(calls[0], 'BEGIN');
    assert.match(calls[1], /pg_advisory_xact_lock/);
    assert.equal(calls.at(-2), 'COMMIT');
    assert.equal(calls.at(-1), 'RELEASE');
    // The payload indexes must be part of the same bootstrap transaction, so a
    // rejected statement rolls back instead of half-creating the schema.
    const commitAt = calls.indexOf('COMMIT');
    for (const ddl of PAYLOAD_PARTIAL_INDEX_DDL) {
      const at = calls.indexOf(ddl);
      assert.ok(at > 0 && at < commitAt, `partial index DDL not inside bootstrap: ${ddl}`);
    }
    // A reaction table created by migration 011 has no author side, so the
    // bootstrap must widen it in the same transaction instead of silently
    // keeping a table whose INSERT would fail on the unknown column.
    const widenAt = calls.findIndex(sql => /ALTER TABLE whatsapp_message_reactions/.test(sql));
    assert.ok(widenAt > 0 && widenAt < commitAt, 'reaction widening not inside bootstrap');
    assert.match(calls[widenAt]!, /ADD COLUMN IF NOT EXISTS from_me boolean/);
  } finally {
    (pg.Pool.prototype as any).connect = original;
  }
});

test('payload partial indexes key on the C collation and reuse the read predicates', () => {
  const indexNames = [
    'idx_whatsapp_message_payloads_pins',
    'idx_whatsapp_message_payloads_event_responses',
  ];
  assert.equal(PAYLOAD_PARTIAL_INDEX_DDL.length, indexNames.length);
  for (let i = 0; i < indexNames.length; i++) {
    const name = indexNames[i]!;
    const ddl = PAYLOAD_PARTIAL_INDEX_DDL[i]!;
    assert.ok(ddl.startsWith(`CREATE INDEX IF NOT EXISTS ${name}`), name);
    assert.ok(
      ddl.includes('(account, conversation_id, wa_message_id COLLATE "C")'),
      `${name} must order the keyset by the C collation`
    );
    const predicate = ddl.slice(ddl.indexOf(' WHERE '));
    assert.ok(
      predicate === ` WHERE ${EVENT_RESPONSE_PRESENT_SQL}` ||
        predicate === ` WHERE ${PIN_ACTION_SQL}`,
      `${name} must reuse the exported read predicate verbatim`
    );
  }
});

interface QueryCall {
  sql: string;
  params: unknown[];
}

type Responder = (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

function stubPool(input: Record<string, unknown>[] | Responder = []): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  const responder: Responder =
    typeof input === 'function' ? input : async () => ({ rows: input });
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    return responder(sql, params);
  };
  return { calls, restore: () => ((pg.Pool.prototype as any).query = original) };
}

function withAccount(account: string): () => void {
  const previous = process.env.CONNECTOR_ACCOUNT;
  process.env.CONNECTOR_ACCOUNT = account;
  resetDurableStoreStateForTests();
  return () => {
    if (previous === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previous;
  };
}

function withEnv(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

/** What pg hands back for a JSONB column: the parsed object, not text. */
function asJsonb(text: string): unknown {
  return JSON.parse(text);
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function textMessage(id: string, remoteJid: string, ts = nowSeconds()): WAMessage {
  return {
    key: { remoteJid, id, fromMe: false },
    message: { conversation: 'hola' },
    messageTimestamp: ts,
    pushName: 'Ada',
  } as WAMessage;
}

const payloadInserts = (calls: QueryCall[]): QueryCall[] =>
  calls.filter(c => /INSERT INTO whatsapp_message_payloads/i.test(c.sql));



test('raw chat storage ignores Novedades IDs that may collide with chat messages', async () => {
  const { calls, restore } = stubPool();
  try {
    for (const remoteJid of ['100@newsletter', '200@newsletter', 'status@broadcast']) {
      await storeRawWAMessage({
        key: { remoteJid, id: 'same' },
        message: { conversation: 'post' },
      });
    }
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('raw WAMessage persistence is account-scoped and durable', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool();
  try {
    await storeRawWAMessage({
      key: { remoteJid: '34600@s.whatsapp.net', id: 'abc', fromMe: false },
      message: { conversation: 'hello' },
      messageTimestamp: 1_700_000_000,
      pushName: 'Ada',
    } as any);
    const insert = calls.find(call => /INSERT INTO whatsapp_message_payloads/i.test(call.sql))!;
    assert.equal(insert.params[0], 'professional:abc');
    assert.equal(insert.params[1], 'professional');
    assert.equal(insert.params[2], 'professional:34600@c.us');
    assert.match(String(insert.params[3]), /remoteJid/);
  } finally {
    restore();
  }
});

test('PN echo payload indexes under its verified LID while preserving the provider key', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const original = pg.Pool.prototype.query;
  const calls: QueryCall[] = [];
  (pg.Pool.prototype as any).query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return {
      rows: /SELECT id FROM conversations/.test(sql) ? [{ id: 'professional:12345@lid' }] : [],
    };
  };
  try {
    await storeRawWAMessage({
      key: { remoteJid: '34600@s.whatsapp.net', id: 'outbound', fromMe: true },
      message: { conversation: 'hello' },
    } as any);
    assert.equal(calls[1].params[2], 'professional:12345@lid');
    assert.match(String(calls[1].params[3]), /34600@s\.whatsapp\.net/);
  } finally {
    (pg.Pool.prototype as any).query = original;
  }
});

test('message mutations persist edit and delete flags without claiming delivery', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool();
  try {
    await markMessageEdited('abc', 'edited text', 'TEXT');
    await markMessageDeleted('abc');
    assert.match(calls[0].sql, /is_edited = TRUE/i);
    assert.equal(calls[0].params[0], 'professional:abc');
    assert.match(calls[1].sql, /is_deleted = TRUE/i);
    assert.equal(calls[1].params[0], 'professional:abc');
  } finally {
    restore();
  }
});

test('read keys select every unread inbound message for one account and chat', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool([
    {
      wa_message_id: 'professional:m1',
      remote_jid: '34600@s.whatsapp.net',
      from_me: false,
      participant_jid: '34600@s.whatsapp.net',
      message_timestamp_ms: '1700000000000',
    },
  ]);
  try {
    const keys = await getMessageKeysForChat('34600@c.us', { unreadOnly: true });
    assert.equal(keys.length, 1);
    assert.equal(keys[0].key.id, 'm1');
    assert.equal(keys[0].key.remoteJid, '34600@s.whatsapp.net');
    const keyQuery = calls.find(call => /FROM whatsapp_message_keys k/i.test(call.sql))!;
    assert.match(keyQuery.sql, /m\.direction = 'INBOUND'/i);
    assert.match(keyQuery.sql, /m\.status IS DISTINCT FROM 'read'/i);
    assert.equal(keyQuery.params[0], 'professional:34600@c.us');
  } finally {
    restore();
  }
});

test('chat state and contacts retain account isolation', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool([{ jid: '34600@s.whatsapp.net', name: 'Ada' }]);
  try {
    await upsertChatState('34600@c.us', { archived: true, pinned: false, muteUntil: null });
    await storeContact({ jid: '34600@s.whatsapp.net', name: 'Ada', phone: '+34600' });
    const contacts = await listStoredContacts();
    assert.equal(contacts[0].name, 'Ada');
    assert.equal(calls[0].params[0], 'professional');
    assert.equal(calls[1].params[0], 'professional');
    assert.equal(calls[2].params[0], 'professional');
  } finally {
    restore();
  }
});

test('raw message lookup returns undefined when no durable row exists', async () => {
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const { restore } = stubPool([]);
  try {
    assert.equal(await getRawWAMessage('missing'), undefined);
  } finally {
    restore();
  }
});

test('raw message lookup uses the same normalized, account-scoped chat key it stores', async () => {
  const previous = process.env.CONNECTOR_ACCOUNT;
  const { calls, restore } = stubPool([
    {
      message_key: JSON.stringify({ remoteJid: '34600@s.whatsapp.net', id: 'abc', fromMe: false }),
      message_payload: JSON.stringify({ conversation: 'hello' }),
      message_timestamp_ms: '1700000000000',
      push_name: 'Ada',
    },
  ]);
  try {
    process.env.CONNECTOR_ACCOUNT = 'personal';
    const personal = await getRawWAMessage('abc', '34600@c.us');
    assert.equal(personal?.message?.conversation, 'hello');
    assert.equal(calls.at(-1)?.params[0], 'abc');
    assert.equal(calls.at(-1)?.params[2], '34600@c.us');
    process.env.CONNECTOR_ACCOUNT = 'professional';
    await getRawWAMessage('abc', '34600@s.whatsapp.net');
    assert.equal(calls.at(-1)?.params[0], 'professional:abc');
    assert.equal(calls.at(-1)?.params[2], 'professional:34600@c.us');
  } finally {
    if (previous === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previous;
    restore();
  }
});

test('read-key lookup normalizes a native Baileys user jid to the stored chat id', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool([]);
  try {
    await getMessageKeysForChat('34600@s.whatsapp.net');
    const keyQuery = calls.find(call => /FROM whatsapp_message_keys k/i.test(call.sql))!;
    assert.equal(keyQuery.params[0], 'professional:34600@c.us');
  } finally {
    restore();
  }
});

test('reactions use an account-scoped target and explicit removal state', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool();
  try {
    await storeMessageReaction({
      targetMessageId: 'target',
      reactorJid: '34600',
      reactionMessageId: 'reaction',
      emoji: ':ok:',
    });
    await storeMessageReaction({ targetMessageId: 'target', reactorJid: '34600', emoji: '' });
    assert.equal(calls[0].params[0], 'professional');
    assert.equal(calls[0].params[1], 'professional:target');
    assert.equal(calls[0].params[5], false);
    assert.equal(calls[1].params[5], true);
  } finally {
    restore();
  }
});

test('reactions record the author side and never invent one on re-ingest', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool();
  try {
    await storeMessageReaction({
      targetMessageId: 'target',
      reactorJid: '34600',
      emoji: ':+1:',
      fromMe: false,
    });
    await storeMessageReaction({
      targetMessageId: 'target',
      reactorJid: '10000:5@s.whatsapp.net',
      emoji: '❤️',
      fromMe: true,
    });
    await storeMessageReaction({ targetMessageId: 'target', reactorJid: '34600', emoji: ':+1:' });
    assert.equal(calls[0].params[6], false, 'a peer reaction');
    assert.equal(calls[1].params[6], true, 'our own device');
    assert.equal(calls[2].params[6], null, 'a key that never said stays unknown');
    assert.match(
      calls[0].sql,
      /from_me = COALESCE\(EXCLUDED\.from_me, whatsapp_message_reactions\.from_me\)/,
      'a history re-ingest that lacks the side must not erase the one already stored'
    );
    for (const call of calls) assertDenseParameters(call.sql, call.params);
  } finally {
    restore();
  }
});

test('RSVP ciphertext pages bind account, event and canonical chat with an explicit continuation', async () => {
  const previous = process.env.CONNECTOR_ACCOUNT;
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool(
    ['one', 'two', 'three'].map(id => ({
      wa_message_id: `professional:${id}`,
      message_key: JSON.stringify({ id, remoteJid: '123@g.us' }),
      message_payload: JSON.stringify({
        encEventResponseMessage: { eventCreationMessageKey: { id: 'event' } },
      }),
    }))
  );
  try {
    const result = await listCapturedEventResponses('event', '123@g.us', {
      cursor: 'before',
      limit: 2,
    });
    assert.equal(result.items.length, 2);
    assert.equal(result.nextCursor, 'two');
    const query = calls.at(-1)!;
    assert.deepEqual(query.params, [
      'professional',
      'event',
      'professional:123@g.us',
      'professional:before',
      3,
    ]);
    assert.match(query.sql, /account = \$1 AND conversation_id = \$3/);
    assert.ok(
      query.sql.includes(EVENT_RESPONSE_PRESENT_SQL),
      'RSVP scan must repeat the partial index predicate verbatim'
    );
    assert.match(query.sql, /ORDER BY wa_message_id COLLATE "C" ASC/);
    assert.ok(
      query.sql.includes('wa_message_id COLLATE "C" > $4::text COLLATE "C"'),
      'continuation must be an index bound rather than a post-scan filter'
    );
    assertDenseParameters(query.sql, query.params);
  } finally {
    restore();
    if (previous === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previous;
  }
});

test('first RSVP page omits the keyset bound and still scans only matching payloads', async () => {
  const previous = process.env.CONNECTOR_ACCOUNT;
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool();
  try {
    assert.deepEqual(await listCapturedEventResponses('event', '123@g.us'), {
      items: [],
      nextCursor: null,
    });
    const query = calls.at(-1)!;
    assert.deepEqual(query.params, ['professional', 'event', 'professional:123@g.us', 201]);
    assert.match(query.sql, /LIMIT \$4$/);
    assert.ok(query.sql.includes(EVENT_RESPONSE_PRESENT_SQL));
    assert.ok(
      !query.sql.includes('wa_message_id COLLATE "C" >'),
      'an unbounded first page must not compare against the cursor'
    );
    assert.ok(!/IS NULL OR/.test(query.sql), 'the cursor must not be folded into a nullable OR');
    assertDenseParameters(query.sql, query.params);
  } finally {
    restore();
    if (previous === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previous;
  }
});

test('RSVP ciphertext empty pages terminate and invalid limits do not silently truncate', async () => {
  const { calls, restore } = stubPool();
  try {
    assert.deepEqual(await listCapturedEventResponses('event', '123@g.us'), {
      items: [],
      nextCursor: null,
    });
    const before = calls.length;
    for (const limit of [0, 501, NaN, 1.5]) {
      await assert.rejects(
        listCapturedEventResponses('event', '123@g.us', { limit }),
        /Invalid event response page/
      );
    }
    assert.equal(calls.length, before);
  } finally {
    restore();
  }
});

test('media payload round-trips Buffers, 64-bit ints and enums through JSONB', () => {
  const mediaKey = Buffer.alloc(32, 7);
  const fileSha256 = Buffer.alloc(32, 9);
  const content = toDurablePayload({
    imageMessage: {
      url: 'https://mmg.whatsapp.net/o1/v/t62/abc',
      directPath: '/o1/v/t62/abc',
      mimetype: 'image/jpeg',
      mediaKey,
      fileSha256,
      fileEncSha256: Buffer.alloc(32, 3),
      fileLength: 123456789,
      caption: 'foto',
      contextInfo: { stanzaId: 'Q1', participant: '34600@s.whatsapp.net' },
    },
  });
  assert.ok(content);
  const stored = asJsonb(serializeDurableValue(content));
  const revived = fromDurablePayload(stored);
  const image = revived.imageMessage!;
  assert.ok(Buffer.isBuffer(image.mediaKey), 'mediaKey revived as a Buffer');
  assert.deepEqual(Buffer.from(image.mediaKey!), mediaKey);
  assert.deepEqual(Buffer.from(image.fileSha256!), fileSha256);
  assert.equal(Number(image.fileLength), 123456789);
  assert.equal(image.directPath, '/o1/v/t62/abc');
  assert.equal(image.contextInfo?.stanzaId, 'Q1');
  // Baileys can encode what we give back (the retry/forward paths do exactly this).
  assert.ok(proto.Message.encode(revived).finish().length > 0);
});

test('thumbnails, nested thumbnails and Signal key material are stripped; media refs kept', () => {
  const content = toDurablePayload({
    senderKeyDistributionMessage: {
      groupId: '123@g.us',
      axolotlSenderKeyDistributionMessage: Buffer.alloc(64, 1),
    },
    extendedTextMessage: {
      text: 'mira https://example.com',
      jpegThumbnail: Buffer.alloc(40_000, 1),
      contextInfo: {
        stanzaId: 'Q2',
        quotedMessage: {
          imageMessage: {
            mediaKey: Buffer.alloc(32, 2),
            jpegThumbnail: Buffer.alloc(30_000, 2),
            directPath: '/q',
          },
        },
      },
    },
  }) as Record<string, any>;
  assert.ok(content);
  assert.equal('senderKeyDistributionMessage' in content, false);
  assert.equal('jpegThumbnail' in content.extendedTextMessage, false);
  const quotedImage = content.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
  assert.equal('jpegThumbnail' in quotedImage, false, 'nested thumbnail stripped too');
  assert.equal(quotedImage.directPath, '/q');
  assert.ok(Buffer.isBuffer(quotedImage.mediaKey), 'mediaKey is kept');
  assert.ok(serializeDurableValue(content).length < 2_000, 'payload stays small');
});

test('large inline blobs go unless their object carries a mediaKey', () => {
  const big = Buffer.alloc(20 * 1024, 5);
  const noKey = toDurablePayload({ imageMessage: { scansSidecar: big, mimetype: 'image/jpeg' } });
  assert.equal('scansSidecar' in (noKey as any).imageMessage, false);
  const withKey = toDurablePayload({
    videoMessage: { mediaKey: Buffer.alloc(32, 1), streamingSidecar: big },
  });
  assert.equal((withKey as any).videoMessage.streamingSidecar.length, big.length);
});

test('protocol messages (key shares, revokes) are never stored', () => {
  assert.equal(toDurablePayload({ protocolMessage: { type: 0 } }), null);
  assert.equal(
    toDurablePayload({ ephemeralMessage: { message: { protocolMessage: { type: 3 } } } }),
    null,
    'wrapped protocol messages too'
  );
  assert.equal(toDurablePayload(null), null);
});

test('BufferJSON helpers accept both the text and the parsed JSONB value', () => {
  const text = serializeDurableValue({ k: Buffer.from('abc') });
  assert.deepEqual((deserializeDurableValue(text) as any).k, Buffer.from('abc'));
  assert.deepEqual((deserializeDurableValue(asJsonb(text)) as any).k, Buffer.from('abc'));
});

test('unixSeconds reads number, string and Long timestamps', () => {
  assert.equal(unixSeconds(1_700_000_000), 1_700_000_000);
  assert.equal(unixSeconds('1700000000'), 1_700_000_000);
  assert.equal(unixSeconds({ low: 1_700_000_000, high: 0 }), 1_700_000_000);
  assert.equal(unixSeconds({ toNumber: () => 42 }), 42);
  assert.equal(unixSeconds(null), undefined);
  assert.equal(unixSeconds(0), undefined);
});

// ---------------------------------------------------------------------------
// History-days filter
// ---------------------------------------------------------------------------

test('history sync is stored only inside DURABLE_PAYLOAD_HISTORY_DAYS (default 7)', () => {
  const restoreEnv = withEnv('DURABLE_PAYLOAD_HISTORY_DAYS', undefined);
  try {
    const now = Date.now();
    const day = 24 * 60 * 60;
    const s = Math.floor(now / 1000);
    assert.equal(shouldStoreDurablePayload('history', s - 6 * day, now), true);
    assert.equal(shouldStoreDurablePayload('history', s - 8 * day, now), false);
    assert.equal(shouldStoreDurablePayload('history', undefined, now), false);
    // live traffic and our own sends are always kept, whatever their age
    assert.equal(shouldStoreDurablePayload('live', s - 400 * day, now), true);
    assert.equal(shouldStoreDurablePayload('sent', undefined, now), true);

    process.env.DURABLE_PAYLOAD_HISTORY_DAYS = '30';
    assert.equal(shouldStoreDurablePayload('history', s - 20 * day, now), true);
    process.env.DURABLE_PAYLOAD_HISTORY_DAYS = '0';
    assert.equal(shouldStoreDurablePayload('history', s, now), false, '0 disables history');
    process.env.DURABLE_PAYLOAD_HISTORY_DAYS = 'nonsense';
    assert.equal(shouldStoreDurablePayload('history', s - 6 * day, now), true, 'bad value → 7');
  } finally {
    restoreEnv();
  }
});

test('an old history-sync message issues no INSERT; a recent one does', async () => {
  const restoreAccount = withAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const old = textMessage('OLD', '34600@s.whatsapp.net', nowSeconds() - 30 * 24 * 60 * 60);
    assert.equal(await storeRawWAMessage(old, '34600@c.us', 'history'), false);
    assert.equal(calls.length, 0);
    const recent = textMessage('NEW', '34600@s.whatsapp.net');
    assert.equal(await storeRawWAMessage(recent, '34600@c.us', 'history'), true);
    assert.equal(payloadInserts(calls).length, 1);
  } finally {
    restore();
    restoreAccount();
  }
});

// ---------------------------------------------------------------------------
// Account scoping (same namespacing as messages / conversations)
// ---------------------------------------------------------------------------

test('professional payload rows use the namespaced ids messages uses', async () => {
  const restoreAccount = withAccount('professional');
  const { calls, restore } = stubPool();
  try {
    assert.equal(
      await storeRawWAMessage(textMessage('abc', '34600@s.whatsapp.net'), '34600@c.us', 'live'),
      true
    );
    const insert = payloadInserts(calls)[0];
    assert.equal(insert.params[0], 'professional:abc');
    assert.equal(insert.params[1], 'professional');
    assert.equal(insert.params[2], 'professional:34600@c.us');
    const key = JSON.parse(String(insert.params[3]));
    assert.equal(key.remoteJid, '34600@s.whatsapp.net', 'provider key kept as received');
    assert.equal(JSON.parse(String(insert.params[4])).conversation, 'hola');
    assert.ok(insert.params[5] instanceof Date);
    assert.equal(insert.params[6], 'Ada');
  } finally {
    restore();
    restoreAccount();
  }
});

test('personal payload rows keep bare ids', async () => {
  const restoreAccount = withAccount('personal');
  const { calls, restore } = stubPool();
  try {
    await storeRawWAMessage(textMessage('abc', '34600@s.whatsapp.net'), '34600@c.us', 'sent');
    const insert = payloadInserts(calls)[0];
    assert.equal(insert.params[0], 'abc');
    assert.equal(insert.params[1], 'personal');
    assert.equal(insert.params[2], '34600@c.us');
  } finally {
    restore();
    restoreAccount();
  }
});

test('a payload over DURABLE_PAYLOAD_MAX_BYTES is skipped', async () => {
  const restoreAccount = withAccount('personal');
  const restoreEnv = withEnv('DURABLE_PAYLOAD_MAX_BYTES', '64');
  const { calls, restore } = stubPool();
  try {
    const msg = textMessage('BIG', '34600@s.whatsapp.net');
    msg.message = { conversation: 'x'.repeat(500) };
    assert.equal(await storeRawWAMessage(msg, '34600@c.us', 'live'), false);
    assert.equal(calls.length, 0);
  } finally {
    restore();
    restoreEnv();
    restoreAccount();
  }
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

test('lookup is account-scoped, accepts a namespaced id and revives the message', async () => {
  const restoreAccount = withAccount('professional');
  const key = serializeDurableValue({ remoteJid: '34600@s.whatsapp.net', id: 'abc', fromMe: true });
  const payload = serializeDurableValue(
    toDurablePayload({ imageMessage: { mediaKey: Buffer.alloc(32, 4), directPath: '/p' } })
  );
  const { calls, restore } = stubPool(async () => ({
    rows: [
      {
        message_key: asJsonb(key),
        message_payload: asJsonb(payload),
        wa_timestamp: new Date(1_700_000_000_000),
        push_name: 'Ada',
      },
    ],
  }));
  try {
    const msg = await getRawWAMessage('professional:abc');
    assert.equal(calls[0].params[0], 'professional:abc');
    assert.equal(calls[0].params[1], 'professional');
    assert.equal(msg?.key.id, 'abc', 'key id handed to Baileys is bare');
    assert.equal(msg?.key.fromMe, true);
    assert.ok(Buffer.isBuffer(msg?.message?.imageMessage?.mediaKey));
    assert.equal(msg?.messageTimestamp, 1_700_000_000);
    assert.equal(msg?.pushName, 'Ada');
  } finally {
    restore();
    restoreAccount();
  }
});

test('lookup returns undefined when no durable row exists or the DB errors', async () => {
  const restoreAccount = withAccount('personal');
  let fail = false;
  const { restore } = stubPool(async () => {
    if (fail) throw Object.assign(new Error('connection reset'), { code: '08006' });
    return { rows: [] };
  });
  try {
    assert.equal(await getRawWAMessage('missing'), undefined);
    fail = true;
    assert.equal(await getRawWAMessage('missing'), undefined);
    assert.equal(await getRawWAMessage(''), undefined);
  } finally {
    restore();
    restoreAccount();
  }
});

// ---------------------------------------------------------------------------
// Fail soft while migration 015 is not applied
// ---------------------------------------------------------------------------

test('missing table (42P01): logged once, no throw, later calls skip the DB', async () => {
  const restoreAccount = withAccount('personal');
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
  const { calls, restore } = stubPool(async () => {
    throw Object.assign(new Error('relation "whatsapp_message_payloads" does not exist'), {
      code: '42P01',
    });
  });
  try {
    const msg = textMessage('abc', '34600@s.whatsapp.net');
    assert.equal(await storeRawWAMessage(msg, '34600@c.us', 'live'), false);
    assert.equal(await storeRawWAMessage(msg, '34600@c.us', 'live'), false);
    assert.equal(await getRawWAMessage('abc'), undefined);
    assert.equal(calls.length, 1, 'after the 42P01 the table is not probed again right away');
    assert.equal(warnings.filter(w => /migration 015/.test(w)).length, 1, 'one log line');
  } finally {
    console.warn = originalWarn;
    restore();
    restoreAccount();
  }
});

test('the table is re-probed after the back-off, so no restart is needed once 009 lands', async () => {
  const restoreAccount = withAccount('personal');
  let missing = true;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const originalNow = Date.now;
  console.warn = () => {};
  console.info = () => {};
  const { calls, restore } = stubPool(async () => {
    if (missing) throw Object.assign(new Error('undefined table'), { code: '42P01' });
    return { rows: [] };
  });
  try {
    const msg = textMessage('abc', '34600@s.whatsapp.net');
    await storeRawWAMessage(msg, '34600@c.us', 'live');
    missing = false;
    const t0 = originalNow();
    Date.now = () => t0 + 6 * 60 * 1000;
    assert.equal(await storeRawWAMessage(msg, '34600@c.us', 'live'), true);
    assert.equal(payloadInserts(calls).length, 2);
  } finally {
    Date.now = originalNow;
    console.warn = originalWarn;
    console.info = originalInfo;
    restore();
    restoreAccount();
  }
});

test('timestamp shape probe supports the legacy, fresh-migration, and expanded NAS tables', async () => {
  const cases = [
    {
      name: 'legacy NAS',
      hasMs: true,
      hasTs: false,
      insert: /message_timestamp_ms/,
      excludes: /wa_timestamp/,
      timestampParam: 1_700_000_000_000,
    },
    {
      name: 'fresh migration 015',
      hasMs: false,
      hasTs: true,
      insert: /wa_timestamp/,
      excludes: /message_timestamp_ms/,
      timestampParam: new Date(1_700_000_000_000),
    },
    {
      name: 'expanded NAS after migration 015',
      hasMs: true,
      hasTs: true,
      insert: /wa_timestamp[\s\S]*message_timestamp_ms/,
      excludes: undefined,
      timestampParam: new Date(1_700_000_000_000),
    },
  ] as const;

  for (const schema of cases) {
    const restoreAccount = withAccount('personal');
    const { calls, restore } = stubPool(async sql => {
      if (/SELECT message_timestamp_ms FROM whatsapp_message_payloads/.test(sql)) {
        if (!schema.hasMs) throw Object.assign(new Error('undefined column'), { code: '42703' });
        return { rows: [] };
      }
      if (/SELECT wa_timestamp FROM whatsapp_message_payloads/.test(sql)) {
        if (!schema.hasTs) throw Object.assign(new Error('undefined column'), { code: '42703' });
        return { rows: [] };
      }
      return { rows: [] };
    });
    try {
      await adoptPayloadTimestampShape();
      const message = textMessage(`${schema.name}-message`, '34600@s.whatsapp.net', 1_700_000_000);
      assert.equal(await storeRawWAMessage(message, '34600@c.us', 'live'), true, schema.name);
      const insert = payloadInserts(calls).at(-1)!;
      assert.match(insert.sql, schema.insert, schema.name);
      if (schema.excludes) assert.doesNotMatch(insert.sql, schema.excludes, schema.name);
      assert.equal(insert.params[5] instanceof Date, schema.timestampParam instanceof Date, schema.name);
      assert.equal(insert.params[5] instanceof Date ? insert.params[5].getTime() : insert.params[5],
        schema.timestampParam instanceof Date ? schema.timestampParam.getTime() : schema.timestampParam,
        schema.name);
    } finally {
      restore();
      restoreAccount();
    }
  }
});

test('expanded-table reads return the old NAS millisecond timestamp after migration backfill', async () => {
  const restoreAccount = withAccount('professional');
  const { calls, restore } = stubPool(async sql => {
    if (/SELECT message_timestamp_ms FROM whatsapp_message_payloads/.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT wa_timestamp FROM whatsapp_message_payloads/.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT message_key, message_payload, COALESCE\(message_timestamp_ms/.test(sql)) {
      return {
        rows: [
          {
            message_key: JSON.stringify({ remoteJid: '34600@s.whatsapp.net', id: 'old' }),
            message_payload: JSON.stringify({ conversation: 'historical NAS row' }),
            message_timestamp_ms: '1700000000000',
            push_name: 'Ada',
          },
        ],
      };
    }
    return { rows: [] };
  });
  try {
    await adoptPayloadTimestampShape();
    const message = await getRawWAMessage('old', '34600@c.us');
    assert.equal(message?.message?.conversation, 'historical NAS row');
    assert.equal(message?.messageTimestamp, 1_700_000_000);
    const query = calls.find(call => /COALESCE\(message_timestamp_ms/.test(call.sql))!;
    assert.ok(query.sql.includes('EXTRACT(EPOCH FROM wa_timestamp)'));
    assert.deepEqual(query.params, ['professional:old', 'professional', 'professional:34600@c.us']);
  } finally {
    restore();
    restoreAccount();
  }
});

test('poll scans fall back to migration timestamp without corrupting the order clause', async () => {
  const restoreAccount = withAccount('personal');
  const { calls, restore } = stubPool(async sql => {
    if (/message_payload, message_timestamp_ms/.test(sql)) {
      throw Object.assign(new Error('undefined column'), { code: '42703' });
    }
    return { rows: [] };
  });
  try {
    assert.deepEqual(await listCapturedPollUpdates(['poll'], '123@g.us'), []);
    assert.equal(calls.length, 2);
    assert.match(
      calls[1]!.sql,
      /EXTRACT\(EPOCH FROM wa_timestamp\)::bigint \* 1000 AS message_timestamp_ms/
    );
    assert.match(calls[1]!.sql, /ORDER BY message_timestamp_ms ASC NULLS FIRST/);
    assert.doesNotMatch(calls[1]!.sql, /AS message_timestamp_ms AS/);
  } finally {
    restore();
    restoreAccount();
  }
});
