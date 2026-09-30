/**
 * Outgoing messages into a chat with disappearing messages on carry the timer
 * (Baileys `ephemeralExpiration` → contextInfo.expiration), as WhatsApp's own
 * clients do: text, media, voice, sticker / GIF, poll, event, contact card and
 * forward. The timer is the one the connector knows — the canonical
 * conversation row (014) or a group's cached metadata. Unknown (never learnt,
 * 014 missing, DB failing, ingest off) or off → the message goes as before.
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import {
  generateForwardMessageContent,
  generateWAMessageFromContent,
  proto,
} from '@whiskeysockets/baileys';
import { BaileysClient, BaileysClientOptions } from './baileys-client';
import { resetDisappearingStateForTests, withEphemeralExpiration } from './disappearing';
import { resetChatStateForTests } from './chat-state';
import { resetDurableStoreStateForTests } from './durable-message-store';

process.env.WA_SEND_ERROR_ACK_WAIT_MS = '0';
process.env.WA_DIRECT_PRIVACY_PREFLIGHT = 'false';

type Rows = Record<string, unknown>[];
interface QueryCall {
  sql: string;
  params: unknown[];
}

function stubPool(route: (sql: string, params: unknown[]) => Rows): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    try {
      const rows = route(sql, params);
      return Promise.resolve({ rows, rowCount: rows.length });
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return {
    calls,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg.Pool.prototype as any).query = original;
    },
  };
}

function useAccount(account: string): void {
  process.env.CONNECTOR_ACCOUNT = account;
  resetDurableStoreStateForTests();
  resetChatStateForTests();
  resetDisappearingStateForTests();
}

const LID = '111@lid';
const PN_LEGACY = '34611111111@c.us';
const GROUP = '120363000000000001@g.us';
const isResolve = (sql: string): boolean => /WITH RECURSIVE hop/.test(sql);
const isTimerRead = (sql: string): boolean => /SELECT ephemeral_expiration/.test(sql);
const isPayloadSelect = (sql: string): boolean =>
  /FROM whatsapp_message_payloads/i.test(sql) && /SELECT/i.test(sql);

/**
 * The DB of a test: the phone chat was merged into its LID conversation; the
 * stored timer of each canonical row (null = never learnt).
 */
function db(
  timers: Record<string, number | null>,
  options: { missingColumns?: boolean; failing?: boolean } = {}
): (sql: string, params: unknown[]) => Rows {
  return (sql, params) => {
    if (isResolve(sql)) {
      const candidates = (params[1] as string[]) || [];
      if (candidates.includes(LID) || candidates.includes(PN_LEGACY)) {
        return [{ id: `professional:${LID}`, external_id: LID }];
      }
      if (candidates.includes(GROUP)) return [{ id: `professional:${GROUP}`, external_id: GROUP }];
      return [];
    }
    if (isTimerRead(sql)) {
      if (options.failing) throw new Error('connection terminated');
      if (options.missingColumns) {
        throw Object.assign(new Error('column "ephemeral_expiration" does not exist'), {
          code: '42703',
        });
      }
      const key = String(params[0]);
      if (!(key in timers)) return [];
      return [{ ephemeral_expiration: timers[key], ephemeral_setting_at: null }];
    }
    if (isPayloadSelect(sql)) {
      return [
        {
          message_key: { remoteJid: '34600@s.whatsapp.net', id: 'ORIG', fromMe: false },
          message_payload: { conversation: 'hola' },
          wa_timestamp: new Date(),
          push_name: null,
        },
      ];
    }
    return [];
  };
}

interface Sent {
  jid: string;
  content: any;
  opts: any;
}

function makeClient(options: BaileysClientOptions = {}): { client: BaileysClient; sent: Sent[] } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const sent: Sent[] = [];
  let n = 0;
  const sock = {
    ev: { on: () => {}, emit: () => {} },
    user: { id: '34600111222:5@s.whatsapp.net', lid: '900:5@lid' },
    signalRepository: {
      lidMapping: { getLIDForPN: async () => null, getPNForLID: async () => null },
    },
    sendMessage: async (jid: string, content: any, opts: any) => {
      sent.push({ jid, content, opts });
      n += 1;
      return {
        key: { remoteJid: jid, id: `SENT${n}`, fromMe: true },
        message: { conversation: 'x' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      };
    },
    end: () => {},
  };
  const internals = client as any;
  internals.sock = sock;
  internals.ready = true;
  internals.lastState = 'CONNECTED';
  internals.isConnected = () => true;
  internals.waitForImmediateSendFailure = async () => undefined;
  internals.persistDurablePayload = async () => {};
  return { client, sent };
}

// ---------------------------------------------------------------------------
// What Baileys rc13 does with the option (the whole point of passing it)
// ---------------------------------------------------------------------------

test('Baileys puts ephemeralExpiration on contextInfo.expiration, forwards included; none without it', () => {
  const userJid = '34600111222@s.whatsapp.net';
  const text = generateWAMessageFromContent(
    LID,
    { extendedTextMessage: { text: 'hola' } },
    { userJid, ephemeralExpiration: 604800 }
  );
  assert.equal(text.message?.extendedTextMessage?.contextInfo?.expiration, 604800);

  const forward = generateForwardMessageContent(
    { key: { id: 'O', remoteJid: LID }, message: { conversation: 'hola' } } as any,
    false
  );
  const forwarded = generateWAMessageFromContent(LID, forward, {
    userJid,
    ephemeralExpiration: 86400,
  });
  const ctx = forwarded.message?.extendedTextMessage?.contextInfo;
  assert.equal(ctx?.expiration, 86400);
  assert.equal(ctx?.isForwarded, true, 'the forward flags survive');

  const plain = generateWAMessageFromContent(
    LID,
    { extendedTextMessage: { text: 'hola' } },
    { userJid }
  );
  assert.equal(plain.message?.extendedTextMessage?.contextInfo?.expiration ?? undefined, undefined);
  assert.ok(proto.Message.fromObject(text.message!), 'still a valid proto');
});

test('withEphemeralExpiration: adds the timer when on; unknown / off leave the options as they were', () => {
  assert.equal(withEphemeralExpiration(undefined, undefined), undefined);
  assert.equal(withEphemeralExpiration(undefined, 0), undefined);
  assert.equal(withEphemeralExpiration(undefined, null), undefined);
  const opts = { messageId: 'M' };
  assert.equal(withEphemeralExpiration(opts, 0), opts);
  assert.deepEqual(withEphemeralExpiration(opts, 86400), {
    messageId: 'M',
    ephemeralExpiration: 86400,
  });
  assert.deepEqual(withEphemeralExpiration(undefined, 7776000), { ephemeralExpiration: 7776000 });
});

// ---------------------------------------------------------------------------
// Every outgoing kind
// ---------------------------------------------------------------------------

test('text to a merged phone chat reads the canonical LID row and carries its timer', async () => {
  useAccount('professional');
  const pool = stubPool(db({ [`professional:${LID}`]: 604800 }));
  try {
    const { client, sent } = makeClient();
    await client.sendMessage(PN_LEGACY, 'hola', { messageId: 'IDEM1' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].opts.ephemeralExpiration, 604800);
    assert.equal(sent[0].opts.messageId, 'IDEM1', 'the idempotent id is kept');
    const read = pool.calls.find(c => isTimerRead(c.sql));
    assert.equal(read?.params[0], `professional:${LID}`, 'the canonical row, not the tombstone');
  } finally {
    pool.restore();
  }
});

test('structured sends (poll, event, contact card, sticker) and voice / file / forward carry it', async () => {
  useAccount('professional');
  const pool = stubPool(db({ [`professional:${LID}`]: 86400 }));
  const originalFetch = globalThis.fetch;
  try {
    const { client, sent } = makeClient();
    await client.sendPoll(LID, { name: 'Cena?', values: ['sí', 'no'], selectableCount: 1 } as any);
    await client.sendEvent(LID, {
      name: 'Cena',
      startTime: new Date('2026-12-01T20:00:00Z'),
    } as any);
    await client.shareContacts(LID, [{ displayName: 'Ada', phone: '+34611111111' }]);
    await client.sendVoice(LID, Buffer.from('OggS'));
    // A tiny WebP (RIFF....WEBPVP8 ) served by a stubbed fetch.
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x1a, 0, 0, 0]),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(14),
    ]);
    globalThis.fetch = (async () =>
      new Response(webp, { headers: { 'content-type': 'image/webp' } })) as typeof fetch;
    await client.sendStickerOrGif('sticker', {
      conversationId: LID,
      fileUrl: 'https://files.example/s.webp',
    } as any);
    await client.sendFile(LID, 'https://files.example/s.webp');
    await client.forwardMessage('34600@c.us', 'ORIG', LID);
    assert.equal(sent.length, 7);
    for (const call of sent) {
      assert.equal(call.jid, LID);
      assert.equal(
        call.opts?.ephemeralExpiration,
        86400,
        JSON.stringify(Object.keys(call.content))
      );
    }
    assert.ok(sent[6].content.forward, 'the forward is still a real forward');
  } finally {
    globalThis.fetch = originalFetch;
    pool.restore();
  }
});

test('a group: its cached metadata timer wins, without a DB read', async () => {
  useAccount('professional');
  const pool = stubPool(db({ [`professional:${GROUP}`]: null }));
  try {
    const { client, sent } = makeClient();
    (client as any).groupMetaCache.set(GROUP, {
      id: GROUP,
      subject: 'Equipo',
      participants: [],
      ephemeralDuration: 7776000,
    });
    await client.sendPoll(GROUP, {
      name: 'Cena?',
      values: ['sí', 'no'],
      selectableCount: 1,
    } as any);
    assert.equal(sent[0].opts.ephemeralExpiration, 7776000);
    assert.equal(pool.calls.filter(c => isTimerRead(c.sql)).length, 0);
    // Turned off in the metadata → nothing, even with a stale row.
    (client as any).groupMetaCache.set(GROUP, { id: GROUP, participants: [] });
    await client.sendPoll(GROUP, { name: 'Otra', values: ['a', 'b'], selectableCount: 1 } as any);
    assert.equal(sent[1].opts, undefined);
  } finally {
    pool.restore();
  }
});

// ---------------------------------------------------------------------------
// Unknown timer → as today
// ---------------------------------------------------------------------------

test('never learnt, off, 014 missing or a failing DB: sent exactly as before', async () => {
  const cases: Array<[string, ReturnType<typeof db>]> = [
    ['no row', db({})],
    ['never learnt (NULL)', db({ [`professional:${LID}`]: null })],
    ['off', db({ [`professional:${LID}`]: 0 })],
    ['014 missing', db({}, { missingColumns: true })],
    ['DB failing', db({}, { failing: true })],
  ];
  for (const [label, route] of cases) {
    useAccount('professional');
    const pool = stubPool(route);
    try {
      const { client, sent } = makeClient();
      await client.sendMessage(LID, 'hola');
      await client.shareContacts(LID, [{ displayName: 'Ada', phone: '+34611111111' }]);
      await client.forwardMessage('34600@c.us', 'ORIG', LID);
      assert.equal(sent.length, 3, label);
      assert.equal(sent[0].opts.ephemeralExpiration, undefined, label);
      assert.equal(sent[1].opts, undefined, `${label}: contact card options untouched`);
      assert.equal(sent[2].opts, undefined, `${label}: forward options untouched`);
    } finally {
      pool.restore();
    }
  }
});

test('ingest off (the pairing pool): no DB read, no timer', async () => {
  useAccount('professional');
  const pool = stubPool(db({ [`professional:${LID}`]: 604800 }));
  try {
    const { client, sent } = makeClient({ ingest: false });
    await client.sendMessage(LID, 'hola');
    assert.equal(sent[0].opts.ephemeralExpiration, undefined);
    assert.equal(pool.calls.length, 0);
  } finally {
    pool.restore();
  }
});
