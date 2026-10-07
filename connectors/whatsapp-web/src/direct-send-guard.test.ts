/**
 * First-contact guard of every new 1:1 send (regression of 01-10).
 *
 * The direct-send preflight refused (account_restricted, "could not obtain a
 * trusted-contact token") a chat that had talked to the account for months:
 * the person's tctoken had aged out of Baileys' 4 weekly buckets (the cutoff
 * moves every Thursday 00:00 UTC) and Baileys' cleanup had emptied the
 * record, while the poll path, with no preflight, went out fine. WA Web and
 * whatsmeow never hold a send back for a missing or expired tctoken.
 *
 * Policy now, the same for text, file, voice, sticker/GIF, contact cards,
 * poll, event, forward and group-invite cards: a known contact (fresh
 * tctoken, any tctoken record, or an INBOUND message on the canonical
 * conversation of their PN or LID) always gets the message; only a true
 * first contact goes through the token preflight and is refused when no
 * token can be attached.
 *
 * No socket and no DB: fake sock / fake key store, stubbed pg.Pool#query.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import pg from 'pg';
import { BaileysClient, WhatsAppSendError } from './baileys-client';
import { hasInboundHistory } from './chat-state';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const LID = '174869610295503@lid';
const PN = '34659695630@s.whatsapp.net';
const DAY = 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);

/** Stub pg.Pool#query; `route` returns rows. */
function stubPool(route: (sql: string, params: unknown[]) => Record<string, unknown>[] = () => []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const original = pg.Pool.prototype.query;
  (pg.Pool.prototype as Any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    const rows = route(sql, params);
    return Promise.resolve({ rows, rowCount: rows.length });
  };
  return {
    calls,
    restore: () => {
      (pg.Pool.prototype as Any).query = original;
    },
  };
}

/** In-memory Baileys key store. */
function keyStore(tctoken: Record<string, unknown> = {}) {
  const data: Record<string, Record<string, unknown>> = { tctoken: { ...tctoken } };
  return {
    data,
    get: async (type: string, ids: string[]) => {
      const out: Record<string, unknown> = {};
      for (const id of ids) if (data[type]?.[id] !== undefined) out[id] = data[type][id];
      return out;
    },
    set: async (update: Record<string, Record<string, unknown>>) => {
      for (const [type, entries] of Object.entries(update)) {
        data[type] ??= {};
        for (const [id, value] of Object.entries(entries)) {
          if (value === null) delete data[type][id];
          else data[type][id] = value;
        }
      }
    },
  };
}

/**
 * The professional account of 01-10: privacy tokens on 1:1, no NCT salt (no
 * cstoken possible), WhatsApp answers the token iq with no token.
 */
function makeClient(tctoken: Record<string, unknown> = {}, inbound = false) {
  const calls = { issued: [] as string[], sent: [] as string[], history: [] as string[][] };
  const sock = {
    ev: { on: () => {}, emit: () => {} },
    user: { id: '34600111222:5@s.whatsapp.net' },
    authState: {
      creds: { me: { id: '34600111222:5@s.whatsapp.net', lid: '900:5@lid' } },
      keys: keyStore(tctoken),
    },
    serverProps: { privacyTokenOn1to1: true, lidTrustedTokenIssueToLid: false },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async (jid: string) => (jid === PN ? LID : null),
        getPNForLID: async (jid: string) => (jid === LID ? `34659695630:0@s.whatsapp.net` : null),
      },
    },
    onWhatsApp: async (jid: string) => [{ jid, exists: true }],
    getUSyncDevices: async () => [],
    issuePrivacyTokens: async (jids: string[]) => {
      calls.issued.push(...jids);
      return { tag: 'iq', attrs: {}, content: [] };
    },
    sendMessage: async (jid: string) => {
      calls.sent.push(jid);
      return { key: { id: `M${calls.sent.length}`, remoteJid: jid, fromMe: true }, message: {} };
    },
  };
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16)) as Any;
  client.sock = sock;
  client.ready = true;
  client.lastState = 'CONNECTED';
  client.isConnected = () => true;
  client.waitForImmediateSendFailure = async () => undefined;
  client.persistDurablePayload = async () => {};
  client.outgoingEphemeral = async () => undefined;
  client.structuredSendTarget = async (chatId: string) => ({
    raw: client.toRawJid(chatId),
    conversationId: client.normalizeJid(client.toRawJid(chatId)),
    canonicalId: null,
  });
  client.afterStructuredSend = async (sent: Any) => ({ messageId: sent.key.id });
  client.directInboundHistory = async (ids: string[]) => {
    calls.history.push(ids);
    return inbound;
  };
  return { client, sock, calls };
}

const restricted = (e: unknown) =>
  e instanceof WhatsAppSendError && e.details.failureClass === 'account_restricted';

// ---------------------------------------------------------------------------
// The regression: a chat that already talks to the account
// ---------------------------------------------------------------------------

test('regression: an expired tctoken (aged out of the 4 weekly buckets) still sends text', async () => {
  const { client, calls } = makeClient({
    [LID]: { token: Buffer.from([1, 2, 3]), timestamp: String(now() - 30 * DAY) },
  });
  assert.equal(await client.sendMessage(LID, 'hola'), 'M1');
  assert.deepEqual(calls.sent, [LID]);
  assert.deepEqual(calls.issued, [], 'no first-contact preflight for a known contact');
});

test('regression: a record Baileys emptied (only senderTimestamp left, as Dani 01-10) sends', async () => {
  const { client, calls } = makeClient({
    [LID]: { token: Buffer.alloc(0), senderTimestamp: now() - 25 * DAY },
  });
  assert.equal(await client.sendMessage(LID, 'hola'), 'M1');
  // Addressed by phone: the token is looked up under the LID.
  assert.equal(await client.sendMessage('34659695630@c.us', 'otra'), 'M2');
  assert.deepEqual(calls.sent, [LID, PN]);
});

test('no tctoken record at all but an INBOUND message in the DB: sends, looked up by LID and PN', async () => {
  const { client, calls } = makeClient({}, true);
  assert.equal(await client.sendMessage(LID, 'hola'), 'M1');
  assert.deepEqual(calls.history, [[LID, PN]]);
  assert.equal(await client.sendMessage(PN, 'hola'), 'M2');
  assert.deepEqual(calls.history[1], [PN, LID]);
  assert.deepEqual(calls.issued, []);
});

test('a fresh tctoken sends without touching the DB', async () => {
  const { client, calls } = makeClient({
    [LID]: { token: Buffer.from([1]), timestamp: String(now() - DAY) },
  });
  assert.equal(await client.sendMessage(LID, 'hola'), 'M1');
  assert.deepEqual(calls.history, []);
});

test('a failed canonical phone lookup preserves the raw recipient and direct-send guard', async () => {
  const original = pg.Pool.prototype.query;
  (pg.Pool.prototype as Any).query = async () => {
    throw new Error('fixture database unavailable');
  };
  try {
    const known = makeClient({
      [LID]: { token: Buffer.from([1]), timestamp: String(now() - DAY) },
    });
    assert.equal(await known.client.sendMessage(PN, 'hola'), 'M1');
    assert.deepEqual(known.calls.sent, [PN]);
    const stranger = makeClient();
    await assert.rejects(stranger.client.sendMessage('34610729350@c.us', 'hola'), restricted);
    assert.deepEqual(stranger.calls.sent, []);
  } finally {
    (pg.Pool.prototype as Any).query = original;
  }
});

// ---------------------------------------------------------------------------
// A true first contact is still refused, on every send path
// ---------------------------------------------------------------------------

test('never contacted (no record, no inbound, no salt): text refused before reaching WhatsApp', async () => {
  const { client, calls } = makeClient();
  await assert.rejects(client.sendMessage('34610729350@c.us', 'hola'), restricted);
  assert.deepEqual(calls.sent, []);
  assert.deepEqual(calls.issued, ['34610729350@s.whatsapp.net'], 'the preflight still tried');
});

test('a failed history lookup counts as no history: a stranger stays refused', async () => {
  const { client, calls } = makeClient();
  client.directInboundHistory = async () => {
    throw new Error('connection refused');
  };
  await assert.rejects(client.sendMessage('34610729350@c.us', 'hola'), restricted);
  assert.deepEqual(calls.sent, []);
});

test('with ingest off (pairing pool) only the tctoken store counts', async () => {
  const { client, calls } = makeClient({}, true);
  client.ingest = false;
  await assert.rejects(client.sendMessage(LID, 'hola'), restricted);
  assert.deepEqual(calls.history, []);
});

test('WA_DIRECT_PRIVACY_PREFLIGHT=false skips the guard', async () => {
  const { client, calls } = makeClient();
  process.env.WA_DIRECT_PRIVACY_PREFLIGHT = 'false';
  try {
    assert.equal(await client.sendMessage('34610729350@c.us', 'hola'), 'M1');
  } finally {
    delete process.env.WA_DIRECT_PRIVACY_PREFLIGHT;
  }
  assert.deepEqual(calls.issued, []);
});

const POLL = { name: 'Q', options: ['a', 'b'], selectableCount: 1 };
const EVENT = { name: 'E', startTime: new Date(Date.now() + DAY * 1000) };
const CARD = [{ displayName: 'Skirmshop', phone: '+34600111222' }];

const otherPaths: Array<[string, (client: Any, jid: string) => Promise<unknown>]> = [
  ['poll', (c, jid) => c.sendPoll(jid, POLL)],
  ['event', (c, jid) => c.sendEvent(jid, EVENT)],
  ['contact card', (c, jid) => c.shareContacts(jid, CARD)],
  ['voice', (c, jid) => c.sendVoice(jid, Buffer.from([1, 2]))],
  [
    'forward',
    (c, jid) => {
      c.currentMessage = async () => ({
        key: { id: 'ORIG', remoteJid: '34611@s.whatsapp.net', fromMe: false },
        message: { conversation: 'x' },
      });
      return c.forwardMessage('34611@c.us', 'ORIG', jid);
    },
  ],
];

for (const [name, send] of otherPaths) {
  test(`${name}: same policy as text — known contact sends, first contact refused`, async () => {
    const known = makeClient({
      [LID]: { token: Buffer.alloc(0), senderTimestamp: now() - 25 * DAY },
    });
    await send(known.client, LID);
    assert.deepEqual(known.calls.sent, [LID]);

    const stranger = makeClient();
    await assert.rejects(send(stranger.client, '34610729350@c.us'), restricted);
    assert.deepEqual(stranger.calls.sent, []);
  });
}

test('file and sticker/GIF: a first contact is refused before the file is fetched', async () => {
  const { client, calls } = makeClient();
  const fetched: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    fetched.push(url);
    throw new Error('unexpected fetch');
  }) as Any;
  try {
    await assert.rejects(
      client.sendFile('34610729350@c.us', 'https://cdn.example/a.jpg', 'hola'),
      restricted
    );
    await assert.rejects(
      client.sendStickerOrGif('sticker', {
        conversationId: '34610729350@c.us',
        fileUrl: 'https://cdn.example/a.webp',
      }),
      restricted
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(fetched, []);
  assert.deepEqual(calls.sent, []);
});

test('groups never go through the 1:1 guard', async () => {
  const { client, calls } = makeClient();
  await client.sendPoll('120363000000000000@g.us', POLL);
  assert.deepEqual(calls.sent, ['120363000000000000@g.us']);
  assert.deepEqual(calls.history, []);
});

// ---------------------------------------------------------------------------
// The DB side: INBOUND on the canonical conversation or a merged twin
// ---------------------------------------------------------------------------

test('hasInboundHistory: canonical conversation of the PN or LID, merged twins included', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const pool = stubPool(sql => {
    if (/WITH RECURSIVE hop/.test(sql)) {
      return [{ id: 'professional:174869610295503@lid', external_id: LID }];
    }
    if (/direction = 'INBOUND'/.test(sql)) return [{ hit: true }];
    return [];
  });
  try {
    assert.equal(await hasInboundHistory([LID, PN]), true);
    const inbound = pool.calls.find(c => /direction = 'INBOUND'/.test(c.sql))!;
    assert.match(inbound.sql, /c\.merged_into = t\.id/);
    assert.deepEqual(inbound.params[0], ['professional:174869610295503@lid']);
  } finally {
    pool.restore();
  }
});

test('hasInboundHistory: no conversation for the number is false, without a messages query', async () => {
  const pool = stubPool(() => []);
  try {
    assert.equal(await hasInboundHistory(['34610729350@s.whatsapp.net']), false);
    assert.equal(
      pool.calls.some(c => /FROM messages/.test(c.sql)),
      false
    );
  } finally {
    pool.restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP: routes that answered 500 keep the 403 account_restricted
// ---------------------------------------------------------------------------

test('POST /messages/forward and /messages/media/send: a refused first contact is 403 account_restricted', async () => {
  const secret = 'direct-send-guard-test-secret';
  const refusal = () =>
    new WhatsAppSendError('WhatsApp send failed (account_restricted): no token', {
      failureClass: 'account_restricted',
      rawJid: '34610729350@s.whatsapp.net',
      normalizedJid: '34610729350@c.us',
      isGroup: false,
      attempts: 0,
      elapsedMs: 1,
    } as Any);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createRouter(
      {
        forwardMessage: async () => {
          throw refusal();
        },
        sendFile: async () => {
          throw refusal();
        },
      } as Any,
      { getCurrentQR: () => null } as Any,
      secret
    )
  );
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: Record<string, unknown>) => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`${base}/api/v1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(ts),
        'x-connector-signature': generateHMACSignature(body, ts, secret),
      },
      body: JSON.stringify(body),
    });
  };
  const previous = process.env.ENABLE_SENDING;
  process.env.ENABLE_SENDING = 'true';
  try {
    const fwd = await post('/messages/forward', {
      chatId: '34611@c.us',
      messageId: 'ORIG',
      toChatId: '34610729350@c.us',
    });
    assert.equal(fwd.status, 403);
    assert.equal((await fwd.json()).failureClass, 'account_restricted');
    const media = await post('/messages/media/send', {
      conversationId: '34610729350@c.us',
      fileUrl: 'https://cdn.example/a.jpg',
    });
    assert.equal(media.status, 403);
    assert.equal((await media.json()).failureClass, 'account_restricted');
  } finally {
    if (previous === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
