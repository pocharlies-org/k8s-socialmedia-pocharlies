/**
 * Durable WhatsApp message payloads (fase 3 / PR-1) — the store module.
 *
 * Ported from the NAS fork's durable-message-store.test.ts and adapted to prod:
 * ids are namespaced with prod's accountKey (no LID canonicalisation, no
 * wa_chat_id lookup), the table comes from mcp-server migration 009 (no runtime
 * DDL) and a missing table fails soft. No real DB: pg.Pool#query is stubbed.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { proto } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import {
  deserializeDurableValue,
  fromDurablePayload,
  getRawWAMessage,
  resetDurableStoreStateForTests,
  serializeDurableValue,
  shouldStoreDurablePayload,
  storeRawWAMessage,
  toDurablePayload,
  unixSeconds,
} from './durable-message-store';

interface QueryCall {
  sql: string;
  params: unknown[];
}

type Responder = (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

function stubPool(responder: Responder = async () => ({ rows: [] })): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    return responder(sql, params);
  };
  return {
    calls,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg.Pool.prototype as any).query = original;
    },
  };
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

// ---------------------------------------------------------------------------
// Serialisation + size control
// ---------------------------------------------------------------------------

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
// Fail soft while migration 009 is not applied
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
    assert.equal(warnings.filter(w => /migration 009/.test(w)).length, 1, 'one log line');
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
