/**
 * Presence (fase 3 / PR-8): what a contact's presence is (in memory, 60 s /
 * typing 8 s, unknown rather than stale, forgotten on reconnect) and our own
 * typing indicator (a chat-state in one chat, throttled, gated) — and that
 * the connector NEVER marks the account `available` on its own: that would
 * silence the phone's push notifications.
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test (same harness as group-management.test.ts).
 * Ported and adapted from the NAS fork's presence-cache.test.ts ("presence
 * expires instead of showing a stale online status") and
 * capabilities-client.test.ts ("presence read remains unknown when provider
 * has not emitted state").
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import pg from 'pg';
import { BaileysClient, BaileysClientOptions } from './baileys-client';
import {
  parsePresenceRequest,
  PRESENCE_TTL_MS,
  PresenceCache,
  PresenceSendThrottle,
  TYPING_TTL_MS,
} from './presence';
import { MessageMutationError } from './message-mutations';
import { resetChatStateForTests } from './chat-state';
import { resetDurableStoreStateForTests } from './durable-message-store';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

type Rows = Record<string, unknown>[];

function stubPool(route: (sql: string, params: unknown[]) => Rows = () => []): {
  calls: Array<{ sql: string; params: unknown[] }>;
  restore: () => void;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    const rows = route(sql, params);
    return Promise.resolve({ rows, rowCount: rows.length });
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
}

const isResolve = (sql: string): boolean => /WITH RECURSIVE hop/.test(sql);

const PN = '34611111111@s.whatsapp.net';
const LID = '111@lid';
const GROUP = '120363000000000001@g.us';

interface SockCalls {
  presence: Array<[string, string | undefined]>;
  subscribed: string[];
}

function makeClient(
  options: BaileysClientOptions = {},
  behaviour: { name?: string | null; presenceError?: unknown } = {}
): { client: BaileysClient; calls: SockCalls; handlers: Record<string, (u: any) => unknown> } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const calls: SockCalls = { presence: [], subscribed: [] };
  const handlers: Record<string, (u: any) => unknown> = {};
  const sock = {
    ev: {
      on: (event: string, fn: (u: any) => unknown) => {
        handlers[event] = fn;
      },
    },
    user: { id: '34600111222:5@s.whatsapp.net', lid: '900:5@lid', name: 'Dani' },
    authState: {
      creds: { me: { id: '34600111222:5@s.whatsapp.net', name: behaviour.name ?? 'Dani' } },
    },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async (pn: string) => (pn === PN ? LID : null),
        getPNForLID: async (lid: string) => (lid === LID ? PN : null),
      },
    },
    sendPresenceUpdate: async (type: string, to?: string) => {
      calls.presence.push([type, to]);
      if (behaviour.presenceError) throw behaviour.presenceError;
    },
    presenceSubscribe: async (jid: string) => {
      calls.subscribed.push(jid);
    },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean };
  internals.sock = sock;
  internals.ready = true;
  return { client, calls, handlers };
}

function priv(client: BaileysClient): any {
  return client as any;
}

function bind(client: BaileysClient): void {
  priv(client).bindSocketEvents(async () => {});
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
}

/** Resolve a known 1:1 chat to its canonical row; everything else unknown. */
function knownChat(externalId = '34611111111@c.us'): (sql: string, params: unknown[]) => Rows {
  return (sql, params) => {
    if (!isResolve(sql)) return [];
    const candidates = (params[1] as string[]) || [];
    if (candidates.includes(externalId) || candidates.includes(GROUP)) {
      const ext = candidates.includes(GROUP) ? GROUP : externalId;
      return [{ id: `professional:${ext}`, external_id: ext }];
    }
    return [];
  };
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

test('presence expires instead of showing a stale online status (fork presence-cache.test)', () => {
  const cache = new PresenceCache();
  const chat = '34600123456@c.us';
  const now = 1_800_000_000_000;
  cache.record(chat, chat, { lastKnownPresence: 'available' }, now);
  assert.equal(cache.read([chat], [], now).presence.status, 'available');
  assert.equal(cache.read([chat], [], now + PRESENCE_TTL_MS - 1).presence.status, 'available');
  assert.equal(cache.read([chat], [], now + PRESENCE_TTL_MS + 1).presence.status, 'unknown');
  assert.equal(cache.size, 0, 'the expired entry is dropped');

  cache.record(chat, chat, { lastKnownPresence: 'composing' }, now);
  assert.equal(cache.read([chat], [], now + TYPING_TTL_MS - 1).presence.status, 'composing');
  assert.equal(cache.read([chat], [], now + TYPING_TTL_MS + 100).presence.status, 'unknown');
  assert.equal(cache.size, 0);
});

test('offline carries its last seen; typing keeps it; unknown values are not kept', () => {
  const cache = new PresenceCache();
  const chat = '34600123456@c.us';
  const now = 1_800_000_000_000;
  cache.record(chat, chat, { lastKnownPresence: 'unavailable', lastSeen: 1_799_999_000 }, now);
  const offline = cache.read([chat], [], now).presence;
  assert.equal(offline.status, 'unavailable');
  assert.equal(offline.lastSeen, new Date(1_799_999_000 * 1000).toISOString());
  cache.record(chat, chat, { lastKnownPresence: 'composing' }, now + 1);
  assert.equal(cache.read([chat], [], now + 2).presence.lastSeen, offline.lastSeen);
  assert.equal(cache.record(chat, chat, { lastKnownPresence: 'weird' }, now), false);
  assert.equal(cache.record(chat, chat, undefined, now), false);
  cache.clear();
  assert.deepEqual(cache.read([chat], [], now).presence, {
    participantId: chat,
    status: 'unknown',
    lastSeen: null,
    observedAt: null,
  });
});

test('a group lists each fresh participant; typing wins the header', () => {
  const cache = new PresenceCache();
  const now = 1_800_000_000_000;
  cache.record(GROUP, 'a@lid', { lastKnownPresence: 'available' }, now);
  cache.record(GROUP, 'b@lid', { lastKnownPresence: 'composing' }, now - 1000);
  const read = cache.read([GROUP], [], now);
  assert.equal(read.presence.status, 'composing');
  assert.equal(read.presence.participantId, 'b@lid');
  assert.deepEqual(
    read.participants.map(p => p.participantId),
    ['b@lid', 'a@lid']
  );
  assert.equal(cache.read([GROUP], ['a@lid'], now).presence.status, 'available');
});

test('the send throttle skips the same state to the same chat for a few seconds', () => {
  const throttle = new PresenceSendThrottle();
  const now = 1_000_000;
  assert.equal(throttle.shouldSend('x', 'composing', now), true);
  throttle.sent('x', 'composing', now);
  assert.equal(throttle.shouldSend('x', 'composing', now + 1000), false);
  assert.equal(throttle.shouldSend('x', 'paused', now + 1000), true, 'a different state goes');
  assert.equal(throttle.shouldSend('y', 'composing', now + 1000), true, 'another chat goes');
  assert.equal(throttle.shouldSend('x', 'composing', now + 3001), true);
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

test('presence requests: chat-states need the chat, account-wide states refuse one', () => {
  assert.deepEqual(parsePresenceRequest({ conversationId: PN, state: ' Composing ' }), {
    state: 'composing',
    conversationId: PN,
  });
  assert.deepEqual(parsePresenceRequest({ state: 'unavailable' }), { state: 'unavailable' });
  assert.deepEqual(parsePresenceRequest({ state: 'available' }), { state: 'available' });
  for (const bad of [
    {},
    { state: 'composing' },
    { state: 'online', conversationId: PN },
    { state: 'typing', conversationId: PN },
    { state: 3, conversationId: PN },
    { state: 'unavailable', conversationId: PN },
    { state: 'available', conversationId: PN },
  ]) {
    assert.throws(
      () => parsePresenceRequest(bad),
      (e: unknown) =>
        e instanceof MessageMutationError &&
        e.status === 400 &&
        e.failureClass === 'invalid_request',
      JSON.stringify(bad)
    );
  }
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

test('presence.update is kept for reads AND still lights the dashboard typing indicator', async () => {
  useAccount('professional');
  const pool = stubPool();
  const posted: Array<{ url: string; body: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    posted.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const { client, handlers } = makeClient();
    bind(client);
    handlers['presence.update']({
      id: PN,
      presences: { [PN]: { lastKnownPresence: 'composing' } },
    });
    handlers['presence.update']({
      id: GROUP,
      presences: { '222:3@lid': { lastKnownPresence: 'available' } },
    });
    await settle();
    // Typing notifier: unchanged (only composing / recording, same payload).
    assert.equal(posted.length, 1);
    assert.match(posted[0].url, /\/api\/messages\/_connector\/typing$/);
    assert.deepEqual(posted[0].body, {
      conversation_id: '34611111111@c.us',
      sender_id: PN,
      sender_name: null,
      status: 'composing',
      ttl_ms: 8000,
    });
    const cache = priv(client).presenceCache as PresenceCache;
    assert.equal(cache.read(['34611111111@c.us']).presence.status, 'composing');
    assert.equal(
      cache.read([GROUP], ['222@lid']).presence.status,
      'available',
      'device suffix dropped'
    );
  } finally {
    globalThis.fetch = originalFetch;
    pool.restore();
  }
});

test('reconnect forgets presence and subscriptions (the old socket said nothing about now)', () => {
  useAccount('professional');
  const pool = stubPool();
  try {
    const { client, handlers } = makeClient({ ingest: false });
    bind(client);
    const cache = priv(client).presenceCache as PresenceCache;
    const subscribed = priv(client).presenceSubscribed as Set<string>;
    cache.record('34611111111@c.us', '34611111111@c.us', { lastKnownPresence: 'available' });
    subscribed.add(PN);
    handlers['connection.update']({ connection: 'close', lastDisconnect: undefined });
    priv(client).intentionalDisconnect = false;
    if (priv(client).reconnectTimer) clearTimeout(priv(client).reconnectTimer);
    assert.equal(cache.size, 0);
    assert.equal(subscribed.size, 0);
    cache.record('34611111111@c.us', '34611111111@c.us', { lastKnownPresence: 'available' });
    subscribed.add(PN);
    handlers['connection.update']({ connection: 'open' });
    assert.equal(cache.size, 0);
    assert.equal(subscribed.size, 0);
    priv(client).stopWatchdog?.();
  } finally {
    pool.restore();
  }
});

test('presence read remains unknown when WhatsApp has not said anything, and re-subscribes once', async () => {
  useAccount('professional');
  const pool = stubPool(knownChat());
  try {
    const { client, calls } = makeClient();
    const first = await client.getPresence('professional:34611111111@c.us');
    assert.equal(first.presence.status, 'unknown');
    assert.equal(first.presence.participantId, '34611111111@c.us');
    assert.equal(first.presence.lastSeen, null);
    assert.equal(first.refreshing, true);
    assert.equal(first.conversationId, 'professional:34611111111@c.us');
    await settle();
    assert.deepEqual(calls.subscribed, [PN]);
    const second = await client.getPresence('34611111111@c.us');
    assert.equal(second.refreshing, false, 'at most one re-subscribe per 30 s');
    assert.deepEqual(calls.subscribed, [PN]);
    assert.equal(calls.presence.length, 0, 'a read never sends our presence');
  } finally {
    pool.restore();
  }
});

test('presence read finds the contact under its LID too, and a group participant by phone', async () => {
  useAccount('professional');
  const pool = stubPool(knownChat());
  try {
    const { client } = makeClient();
    const cache = priv(client).presenceCache as PresenceCache;
    cache.record(LID, LID, { lastKnownPresence: 'unavailable', lastSeen: 1_790_000_000 });
    const read = await client.getPresence('34611111111@c.us');
    assert.equal(read.presence.status, 'unavailable');
    assert.equal(read.presence.lastSeen, new Date(1_790_000_000 * 1000).toISOString());
    assert.equal(read.refreshing, false);
    assert.deepEqual(read.participants, [], 'a direct chat lists nobody');

    cache.record(GROUP, LID, { lastKnownPresence: 'composing' });
    const group = await client.getPresence(GROUP, '+34 611 11 11 11');
    assert.equal(group.isGroup, true);
    assert.equal(group.presence.status, 'composing');
    assert.equal(group.presence.participantId, LID);
    await assert.rejects(
      client.getPresence(GROUP, 'hola'),
      (e: unknown) => e instanceof MessageMutationError && e.status === 400
    );
    await assert.rejects(
      client.getPresence('status@broadcast'),
      (e: unknown) => e instanceof MessageMutationError && e.status === 400
    );
  } finally {
    pool.restore();
  }
});

test('typing goes as a chat-state to the canonical chat, throttled; unknown chats are 404', async () => {
  useAccount('professional');
  const pool = stubPool(knownChat());
  try {
    const { client, calls } = makeClient();
    const sent = await client.sendPresence('composing', 'professional:34611111111@c.us', {
      actor: 'dani',
    });
    assert.deepEqual(sent, {
      state: 'composing',
      scope: 'chat',
      chatId: '34611111111@c.us',
      conversationId: 'professional:34611111111@c.us',
      sent: true,
      throttled: false,
    });
    const again = await client.sendPresence('composing', '34611111111@c.us');
    assert.equal(again.sent, false);
    assert.equal(again.throttled, true);
    await client.sendPresence('paused', '34611111111@c.us');
    await client.sendPresence('recording', GROUP);
    assert.deepEqual(calls.presence, [
      ['composing', PN],
      ['paused', PN],
      ['recording', GROUP],
    ]);
    await assert.rejects(
      client.sendPresence('composing', '34699999999@c.us'),
      (e: unknown) =>
        e instanceof MessageMutationError &&
        e.status === 404 &&
        e.failureClass === 'conversation_unavailable'
    );
    assert.equal(calls.presence.length, 3);
  } finally {
    pool.restore();
  }
});

test('NEVER available by default: 403 unless WA_PRESENCE_ALLOW_AVAILABLE; unavailable is account-wide', async () => {
  useAccount('professional');
  const pool = stubPool(knownChat());
  const previous = process.env.WA_PRESENCE_ALLOW_AVAILABLE;
  try {
    delete process.env.WA_PRESENCE_ALLOW_AVAILABLE;
    const { client, calls } = makeClient();
    await assert.rejects(
      client.sendPresence('available'),
      (e: unknown) =>
        e instanceof MessageMutationError &&
        e.status === 403 &&
        e.failureClass === 'presence_available_disabled'
    );
    process.env.WA_PRESENCE_ALLOW_AVAILABLE = 'yes';
    await assert.rejects(client.sendPresence('available'), MessageMutationError);
    const off = await client.sendPresence('unavailable');
    assert.deepEqual(off, {
      state: 'unavailable',
      scope: 'account',
      chatId: null,
      conversationId: null,
      sent: true,
      throttled: false,
    });
    assert.deepEqual(calls.presence, [['unavailable', undefined]]);

    process.env.WA_PRESENCE_ALLOW_AVAILABLE = 'true';
    await client.sendPresence('available');
    assert.deepEqual(calls.presence.at(-1), ['available', undefined]);

    // Baileys drops available / unavailable silently without a push name.
    const nameless = makeClient({}, { name: '' });
    await assert.rejects(
      nameless.client.sendPresence('unavailable'),
      (e: unknown) => e instanceof MessageMutationError && e.failureClass === 'presence_unsupported'
    );
    assert.equal(nameless.calls.presence.length, 0);
  } finally {
    if (previous === undefined) delete process.env.WA_PRESENCE_ALLOW_AVAILABLE;
    else process.env.WA_PRESENCE_ALLOW_AVAILABLE = previous;
    pool.restore();
  }
});

test('nothing the connector does on its own sends available (connect, reads, typing, handlers)', async () => {
  useAccount('professional');
  const pool = stubPool(knownChat());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}')) as typeof fetch;
  try {
    const { client, calls, handlers } = makeClient();
    bind(client);
    handlers['connection.update']({ connection: 'open' });
    handlers['chats.upsert']([{ id: PN, unreadCount: 0 }]);
    handlers['presence.update']({
      id: PN,
      presences: { [PN]: { lastKnownPresence: 'available' } },
    });
    await client.getPresence(PN);
    await client.sendPresence('composing', PN);
    await client.sendPresence('paused', PN);
    await settle();
    priv(client).stopWatchdog?.();
    assert.ok(
      calls.presence.every(([type]) => type !== 'available'),
      JSON.stringify(calls.presence)
    );
    // The socket option and the source: no implicit online anywhere.
    const source = readFileSync(new URL('./baileys-client.ts', import.meta.url), 'utf8');
    assert.match(source, /markOnlineOnConnect: false/);
    assert.doesNotMatch(source, /sendPresenceUpdate\(\s*['"]available['"]/);
  } finally {
    globalThis.fetch = originalFetch;
    pool.restore();
  }
});

test('ingest off (the pairing pool) binds no presence handler', () => {
  const { client, handlers } = makeClient({ ingest: false });
  bind(client);
  assert.equal(handlers['presence.update'], undefined);
  assert.equal(handlers['chats.update'], undefined);
  assert.equal(handlers['chats.upsert'], undefined);
  assert.ok(handlers['connection.update']);
});

test('a WhatsApp refusal of a presence is 422 rejected_by_whatsapp; a timeout stays a timeout', async () => {
  useAccount('professional');
  const pool = stubPool(knownChat());
  try {
    const refused = makeClient(
      {},
      {
        presenceError: Object.assign(new Error('bad'), {
          isBoom: true,
          output: { statusCode: 400 },
        }),
      }
    );
    await assert.rejects(
      refused.client.sendPresence('composing', PN),
      (e: unknown) => e instanceof MessageMutationError && e.status === 422 && e.code === '400'
    );
    const slow = makeClient({}, { presenceError: new Error('Timed Out') });
    await assert.rejects(slow.client.sendPresence('composing', PN), /Timed Out/);
  } finally {
    pool.restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Call = (method: string, path: string, body?: unknown) => Promise<globalThis.Response>;

async function withRouter(
  client: Partial<BaileysClient>,
  env: Record<string, string | undefined>,
  run: (call: Call) => Promise<void>
): Promise<void> {
  const secret = 'test-secret';
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createRouter(client as BaileysClient, { getCurrentQR: () => null } as never, secret)
  );
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const call: Call = (method, path, body) => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(ts),
        'x-connector-signature': generateHMACSignature(body ?? {}, ts, secret),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await run(call);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
}

function recordingClient(connected = true): { client: Partial<BaileysClient>; seen: unknown[] } {
  const seen: unknown[] = [];
  const client = {
    isConnected: () => connected,
    getCachedState: () => (connected ? 'CONNECTED' : 'CLOSED:428'),
    sendPresence: async (state: string, chatId?: string, request?: { actor?: string }) => {
      seen.push({ send: state, chatId, ...request });
      return { state, scope: chatId ? 'chat' : 'account', chatId, sent: true } as never;
    },
    getPresence: async (chatId: unknown, participant?: unknown) => {
      seen.push({ read: chatId, participant });
      return { chatId, presence: { status: 'unknown' } } as never;
    },
  };
  return { client: client as unknown as Partial<BaileysClient>, seen };
}

const ON = {
  ENABLE_SENDING: 'true',
  EMERGENCY_DISABLE_SENDING: undefined,
  WA_PRESENCE_ALLOW_AVAILABLE: undefined,
};

test('HTTP: the sending gate blocks our presence (not the read); 400 comes first', async () => {
  const { client, seen } = recordingClient();
  for (const env of [
    { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: undefined, EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' },
  ]) {
    await withRouter(client, env, async call => {
      const bad = await call('POST', '/chats/presence', { conversationId: PN, state: 'online' });
      assert.equal(bad.status, 400);
      for (const body of [{ conversationId: PN, state: 'composing' }, { state: 'unavailable' }]) {
        const res = await call('POST', '/chats/presence', body);
        assert.equal(res.status, 403);
        assert.equal(
          ((await res.json()) as { failureClass: string }).failureClass,
          'disabled_sending'
        );
      }
      const read = await call('POST', '/chats/presence/read', { conversationId: PN });
      assert.equal(read.status, 200);
    });
  }
  assert.deepEqual(seen, [
    { read: PN, participant: undefined },
    { read: PN, participant: undefined },
    { read: PN, participant: undefined },
  ]);
});

test('HTTP: available is 403 presence_available_disabled even with sending on (unless opted in)', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async call => {
    const res = await call('POST', '/chats/presence', { state: 'available' });
    assert.equal(res.status, 403);
    assert.equal(
      ((await res.json()) as { failureClass: string }).failureClass,
      'presence_available_disabled'
    );
  });
  assert.deepEqual(seen, []);
  await withRouter(client, { ...ON, WA_PRESENCE_ALLOW_AVAILABLE: 'true' }, async call => {
    const res = await call('POST', '/chats/presence', { state: 'available', actor: 'dani' });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(seen, [{ send: 'available', chatId: undefined, actor: 'dani' }]);
});

test('HTTP: 200 shapes carry the ids of the signed body; 503 when disconnected; errors mapped', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async call => {
    const sent = await call('POST', '/chats/presence', {
      conversationId: 'professional:34611111111@c.us',
      state: 'composing',
      actor: 'dani',
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(await sent.json(), {
      ok: true,
      state: 'composing',
      scope: 'chat',
      chatId: 'professional:34611111111@c.us',
      sent: true,
    });
    const read = await call('POST', '/chats/presence/read', {
      conversationId: GROUP,
      participant: LID,
    });
    assert.deepEqual(await read.json(), {
      presence: { chatId: GROUP, presence: { status: 'unknown' } },
    });
    const missing = await call('POST', '/chats/presence/read', {});
    assert.equal(missing.status, 400);
  });
  assert.deepEqual(seen, [
    { send: 'composing', chatId: 'professional:34611111111@c.us', actor: 'dani' },
    { read: GROUP, participant: LID },
  ]);

  const offline = recordingClient(false);
  await withRouter(offline.client, ON, async call => {
    for (const [path, body] of [
      ['/chats/presence', { conversationId: PN, state: 'composing' }],
      ['/chats/presence/read', { conversationId: PN }],
    ] as const) {
      const res = await call('POST', path, body);
      assert.equal(res.status, 503, path);
      assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'disconnected');
    }
  });
  assert.deepEqual(offline.seen, []);

  const failing = {
    isConnected: () => true,
    getCachedState: () => 'CONNECTED',
    sendPresence: async () => {
      throw new MessageMutationError('unknown chat', 404, 'conversation_unavailable');
    },
  };
  await withRouter(failing as never, ON, async call => {
    const res = await call('POST', '/chats/presence', { conversationId: PN, state: 'paused' });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      error: 'unknown chat',
      failureClass: 'conversation_unavailable',
    });
  });
});

test('HTTP: unsigned bodies are 401 before anything runs', async () => {
  const { client, seen } = recordingClient();
  const secret = 'test-secret';
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createRouter(client as BaileysClient, { getCurrentQR: () => null } as never, secret)
  );
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    for (const path of ['/chats/presence', '/chats/presence/read']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: PN, state: 'composing' }),
      });
      assert.equal(res.status, 401, path);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.deepEqual(seen, []);
});
