/**
 * Contact block / unblock and the blocklist (fase 3 follow-up): the
 * provider's own blocklist is the only proof (every spelling it stores is the
 * same contact, both identities cleared on unblock, a refusal never reported
 * as done, Baileys' "Unable to resolve" as 422 identity_unresolved); the
 * target resolves to the canonical conversation's jid (merged rows, PN ↔ LID
 * aliases); the list collapses one entry per person with names; the cache
 * follows blocklist.update; and the HTTP surface (signed body, confirm: true
 * and 400s first, the sending gate, 503 offline, the list ungated).
 *
 * No socket and no DB: a provider-shaped fake socket and pg.Pool#query
 * stubbed per test (same harness as start-chat-contacts.test.ts). Provider
 * cases ported from the NAS fork's contact-block / blocked-contacts tests.
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
import { BaileysClient } from './baileys-client';
import {
  contactBlockJid,
  ContactBlockError,
  normalizeProviderContactJid,
  parseContactBlockRequest,
  providerBlocklistEntries,
  readContactBlocked,
  setContactBlocked,
} from './contact-block';
import { BlocklistCache, groupBlockedPeople } from './blocked-contacts';
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

const isWrite = (sql: string): boolean => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql);

/*
 * Provider-shaped fixture: the blocklist keeps one raw entry per identity, in
 * the spelling the provider happened to store, and a write is answered the
 * way Baileys answers it (its own normalization, then add or remove). With
 * `exactSpelling` the provider only removes an entry whose stored spelling is
 * identical to the address written. `refuse` rejects a write before it lands.
 */
function provider(options: {
  blocked: string[];
  mapping?: Record<string, string>;
  exactSpelling?: boolean;
  refuse?: (jid: string, action: string) => string | null;
}) {
  const bare = (jid: string) => jid.replace(/^(\d+):\d+@/, '$1@');
  const userAddress = (jid: string) => bare(jid).replace(/@c\.us$/, '@s.whatsapp.net');
  const sameEntry = (entry: string, written: string) =>
    options.exactSpelling
      ? bare(entry) === bare(written)
      : userAddress(entry) === userAddress(written);
  const state = { blocked: [...options.blocked], writes: [] as string[], reads: 0 };
  const mapping = options.mapping ?? {};
  const socket = {
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid: string) => mapping[lid] ?? null,
        getLIDForPN: async (pn: string) => mapping[pn] ?? null,
      },
    },
    fetchBlocklist: async () => {
      state.reads += 1;
      return [...state.blocked];
    },
    updateBlockStatus: async (jid: string, action: string) => {
      state.writes.push(`${action}:${jid}`);
      const reason = options.refuse?.(jid, action) ?? null;
      if (reason)
        throw Object.assign(new Error(reason), { isBoom: true, output: { statusCode: 400 } });
      if (action === 'unblock') {
        state.blocked = state.blocked.filter(entry => !sameEntry(entry, jid));
        return;
      }
      const added = [userAddress(jid), mapping[userAddress(jid)]].filter(
        (value, index, list): value is string =>
          typeof value === 'string' && list.indexOf(value) === index
      );
      state.blocked = [...new Set([...state.blocked, ...added])];
    },
  };
  return { socket, state };
}

const fails = (status: number, failureClass: string, message?: RegExp) => (error: unknown) =>
  error instanceof ContactBlockError &&
  error.status === status &&
  error.failureClass === failureClass &&
  (!message || message.test(error.message));

// ---------------------------------------------------------------------------
// Spelling, input
// ---------------------------------------------------------------------------

test('provider spellings: devices dropped, @c.us → @s.whatsapp.net, LID kept, junk and groups out', () => {
  useAccount('professional');
  assert.deepEqual(
    providerBlocklistEntries([
      '34600111223@lid',
      '34600111222@s.whatsapp.net',
      '34600111221@c.us',
      '34600111220:7@lid',
      '34600111223@lid',
      undefined,
      null,
      42,
      '',
      '120341@newsletter',
      '123@g.us',
      'status@broadcast',
      'user:123@lid',
    ]),
    [
      '34600111220@lid',
      '34600111221@s.whatsapp.net',
      '34600111222@s.whatsapp.net',
      '34600111223@lid',
    ]
  );
  for (const raw of [null, {}, '34600111222@s.whatsapp.net', 7]) {
    assert.throws(() => providerBlocklistEntries(raw), fails(502, 'provider_invalid_response'));
  }
  assert.equal(normalizeProviderContactJid('34600111222:3@c.us'), '34600111222@s.whatsapp.net');
  assert.equal(contactBlockJid('professional:111@lid'), '111@lid');
  assert.equal(contactBlockJid('34600111222@c.us'), '34600111222@s.whatsapp.net');
  for (const bad of ['123@g.us', '123@newsletter', 'status@broadcast', 7, ''])
    assert.throws(() => contactBlockJid(bad), fails(400, 'invalid_request'));
});

test('block input: one target (phone | conversationId), block|unblock, confirm: true, groups refused', () => {
  assert.deepEqual(
    parseContactBlockRequest({ phone: '611111111', action: 'block', confirm: true }).phone?.rawJid,
    '34611111111@s.whatsapp.net'
  );
  assert.deepEqual(
    parseContactBlockRequest({
      conversationId: 'professional:111@lid',
      action: 'unblock',
      confirm: true,
    }),
    { action: 'unblock', conversationId: 'professional:111@lid' }
  );
  for (const [body, message] of [
    [{ phone: '611111111', action: 'block' }, /confirm: true/],
    [{ phone: '611111111', action: 'block', confirm: 'true' }, /confirm: true/],
    [{ phone: '611111111', confirm: true }, /action/],
    [{ phone: '611111111', action: 'mute', confirm: true }, /action/],
    [{ action: 'block', confirm: true }, /Exactly one/],
    [
      { phone: '611111111', conversationId: '111@lid', action: 'block', confirm: true },
      /Exactly one/,
    ],
    [{ phone: 'nope', action: 'block', confirm: true }, /phone/],
    [{ conversationId: 7, action: 'block', confirm: true }, /string/],
    [{ conversationId: '120363@g.us', action: 'block', confirm: true }, /group/],
  ] as const) {
    assert.throws(
      () => parseContactBlockRequest(body as Record<string, unknown>),
      fails(400, 'invalid_request', message),
      JSON.stringify(body)
    );
  }
});

// ---------------------------------------------------------------------------
// Provider: the blocklist is the proof
// ---------------------------------------------------------------------------

test('block then unblock: confirmed by re-reading the blocklist, idempotent across PN / LID', async () => {
  const mapping = {
    '34600111222@s.whatsapp.net': '777@lid',
    '777@lid': '34600111222@s.whatsapp.net',
  };
  const fixture = provider({ blocked: [], mapping });
  // Baileys writes the LID with pn_jid: the fixture stores what the PN maps to.
  const blocked = await setContactBlocked(fixture.socket, '34600111222@c.us', true);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.changed, true);
  assert.equal(blocked.confirmed, true);
  assert.deepEqual(blocked.jids, ['34600111222@s.whatsapp.net', '777@lid']);
  assert.equal(await readContactBlocked(fixture.socket, '777@lid'), true);
  assert.equal((await setContactBlocked(fixture.socket, '777@lid', true)).changed, false);
  assert.deepEqual(fixture.state.writes, ['block:34600111222@s.whatsapp.net']);
  assert.equal((await setContactBlocked(fixture.socket, '777@lid', false)).changed, true);
  assert.equal(
    (await setContactBlocked(fixture.socket, '34600111222@s.whatsapp.net', false)).changed,
    false
  );
  assert.deepEqual(fixture.state.blocked, []);
});

test('every spelling the provider stores is read back and unblocked as the same contact', async () => {
  for (const stored of [
    '34600111221@s.whatsapp.net',
    '34600111221@c.us',
    '34600111221:7@s.whatsapp.net',
    '34600111221:7@c.us',
  ]) {
    const fixture = provider({ blocked: [stored] });
    const chat = '34600111221@s.whatsapp.net';
    assert.equal(await readContactBlocked(fixture.socket, chat), true, stored);
    assert.equal((await setContactBlocked(fixture.socket, chat, false)).changed, true, stored);
    assert.deepEqual(fixture.state.blocked, [], `provider still holds ${stored}`);
  }
});

test('a contact blocked under both identities is fully unblocked (LID first), then confirmed', async () => {
  const mapping = { '111@lid': '222@s.whatsapp.net', '222@s.whatsapp.net': '111@lid' };
  const fixture = provider({ blocked: ['111@lid', '222@s.whatsapp.net'], mapping });
  assert.equal(
    (await setContactBlocked(fixture.socket, '222@s.whatsapp.net', false)).changed,
    true
  );
  assert.deepEqual(fixture.state.blocked, []);
  assert.deepEqual(fixture.state.writes, ['unblock:111@lid', 'unblock:222@s.whatsapp.net']);
});

test('an unblock the provider did not carry out is 409 block_not_confirmed, never "done"', async () => {
  const fixture = provider({ blocked: ['34600111221@c.us'], exactSpelling: true });
  await assert.rejects(
    setContactBlocked(fixture.socket, '34600111221@s.whatsapp.net', false),
    fails(409, 'block_not_confirmed', /not confirmed/)
  );
  assert.deepEqual(fixture.state.blocked, ['34600111221@c.us']);
});

test('Baileys cannot map PN ↔ LID → 422 identity_unresolved; other refusals 422 rejected_by_whatsapp', async () => {
  const unresolved = provider({
    blocked: [],
    refuse: () => 'Unable to resolve LID for PN JID: 34600111222@s.whatsapp.net',
  });
  await assert.rejects(
    setContactBlocked(unresolved.socket, '34600111222@s.whatsapp.net', true),
    fails(422, 'identity_unresolved', /phone and LID/)
  );
  const refused = provider({ blocked: [], refuse: () => 'not-acceptable' });
  await assert.rejects(
    setContactBlocked(refused.socket, '34600111222@s.whatsapp.net', true),
    fails(422, 'rejected_by_whatsapp', /not-acceptable/)
  );
  // The same refusal is a success when the change had landed anyway.
  const landed = provider({ blocked: ['34600111222@s.whatsapp.net'] });
  const inner = landed.socket.updateBlockStatus;
  landed.socket.updateBlockStatus = async (jid: string, action: string) => {
    await inner(jid, action);
    throw new Error('timeout');
  };
  assert.equal(
    (await setContactBlocked(landed.socket, '34600111222@s.whatsapp.net', false)).changed,
    true
  );
});

test('an unusable blocklist answer is 502 on the read and on the write', async () => {
  for (const answer of [null, undefined, 'no-list', 7]) {
    const socket = { fetchBlocklist: async () => answer, signalRepository: { lidMapping: {} } };
    await assert.rejects(
      readContactBlocked(socket, '123@s.whatsapp.net'),
      fails(502, 'provider_invalid_response')
    );
    await assert.rejects(
      setContactBlocked(socket, '123@s.whatsapp.net', false),
      fails(502, 'provider_invalid_response')
    );
  }
});

// ---------------------------------------------------------------------------
// Cache, grouping
// ---------------------------------------------------------------------------

test('cache: fresh within its TTL, patched by blocklist.update, an add on an unknown list ignored', () => {
  const cache = new BlocklistCache(1000);
  cache.apply({ blocklist: ['1@lid'], type: 'add' });
  assert.equal(cache.last(), null, 'an add says nothing about the rest of an unread list');
  cache.set(['1@lid', '2@c.us'], 10_000);
  assert.deepEqual(cache.fresh(10_500), ['1@lid', '2@s.whatsapp.net']);
  cache.apply({ blocklist: ['3:4@lid'], type: 'add' });
  cache.apply({ blocklist: ['1@lid'], type: 'remove' });
  assert.deepEqual(cache.fresh(10_500), ['2@s.whatsapp.net', '3@lid']);
  assert.equal(cache.fresh(11_001), null, 'expired');
  cache.apply({ blocklist: ['9@lid'] }, true);
  assert.deepEqual(cache.last()?.jids, ['9@lid']);
  cache.clear();
  assert.equal(cache.last(), null);
});

test('grouping: PN and LID of one person are one entry, whatever order they come in', async () => {
  const aliases: Record<string, string[]> = {
    '111@lid': ['222@s.whatsapp.net'],
    '222@s.whatsapp.net': [],
    '333@lid': [],
  };
  assert.deepEqual(
    await groupBlockedPeople(
      ['222@s.whatsapp.net', '333@lid', '111@lid'],
      async jid => aliases[jid] || []
    ),
    [
      { blocked: ['333@lid'], jids: ['333@lid'] },
      { blocked: ['111@lid', '222@s.whatsapp.net'], jids: ['111@lid', '222@s.whatsapp.net'] },
    ]
  );
});

// ---------------------------------------------------------------------------
// Client: target resolution, list with names (fake socket, stubbed pool)
// ---------------------------------------------------------------------------

function makeClient(fixture: ReturnType<typeof provider>, ingest = true): BaileysClient {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), { ingest });
  const internals = client as unknown as { sock: unknown; ready: boolean };
  internals.sock = { ev: { on: () => {} }, end: () => {}, ...fixture.socket };
  internals.ready = true;
  return client;
}

const isResolve = (sql: string): boolean => /WITH RECURSIVE hop/.test(sql);
const isAliasResolve = (sql: string): boolean =>
  /FROM social_contact_aliases a\s+JOIN conversations/.test(sql);

test('client: a merged phone conversation blocks its canonical LID; a phone resolves through the alias', async () => {
  useAccount('professional');
  const pool = stubPool((sql, params) => {
    const candidates = (params[1] as string[]) || [];
    if (isResolve(sql) && candidates.includes('34611111111@c.us')) {
      // The phone row is merged into the LID one.
      return [{ id: 'professional:111@lid', external_id: '111@lid' }];
    }
    return [];
  });
  try {
    const mapping = {
      '111@lid': '34611111111@s.whatsapp.net',
      '34611111111@s.whatsapp.net': '111@lid',
    };
    const fixture = provider({ blocked: [], mapping });
    const client = makeClient(fixture);
    const byConversation = await client.setContactBlock(
      { action: 'block', conversationId: 'professional:34611111111@c.us' },
      { actor: 'dani' }
    );
    assert.equal(byConversation.jid, '111@lid');
    assert.equal(byConversation.conversationId, 'professional:111@lid');
    assert.equal(byConversation.blocked, true);
    assert.deepEqual(fixture.state.writes, ['block:111@lid']);

    const byPhone = await client.setContactBlock({
      action: 'unblock',
      phone: {
        phoneE164: '+34611111111',
        digits: '34611111111',
        waJid: '34611111111@c.us',
        rawJid: '34611111111@s.whatsapp.net',
      },
    });
    assert.equal(byPhone.jid, '111@lid');
    assert.equal(byPhone.changed, true);
    assert.deepEqual(fixture.state.blocked, []);
    assert.equal(
      pool.calls.some(call => isWrite(call.sql)),
      false,
      'blocking never writes the DB'
    );
  } finally {
    pool.restore();
  }
});

test('client: a group conversation is 400; a pairing client (ingest off) never touches the DB', async () => {
  useAccount('professional');
  const pool = stubPool();
  try {
    const fixture = provider({ blocked: [] });
    await assert.rejects(
      makeClient(fixture).setContactBlock({ action: 'block', conversationId: '120363@g.us' }),
      (error: unknown) => (error as { status?: number }).status === 400
    );
    pool.calls.length = 0;
    const pairing = makeClient(provider({ blocked: ['34622222222@s.whatsapp.net'] }), false);
    const list = await pairing.listBlockedContacts();
    assert.deepEqual(list.blocked, [
      {
        id: '34622222222@s.whatsapp.net',
        jids: ['34622222222@s.whatsapp.net'],
        blockedJids: ['34622222222@s.whatsapp.net'],
        phone: '+34622222222',
        name: null,
        pushName: null,
        conversationId: null,
      },
    ]);
    assert.equal(pool.calls.length, 0);
  } finally {
    pool.restore();
  }
});

test('client: the list collapses PN + LID per person, names it, and serves the cache until it expires', async () => {
  useAccount('professional');
  const pool = stubPool((sql, params) => {
    if (/SELECT a\.alias_external_id, a\.canonical_external_id/.test(sql)) {
      return [
        {
          alias_external_id: 'professional:34633333333@c.us',
          canonical_external_id: 'professional:333@lid',
        },
      ];
    }
    if (/UNION ALL\s+SELECT p\.external_id/.test(sql)) {
      return [
        {
          external_id: 'professional:333@lid',
          name: 'Lucía',
          push_name: null,
          source: 'conversation',
        },
        {
          external_id: 'professional:34633333333@c.us',
          name: null,
          push_name: 'Lu',
          source: 'participant',
        },
        {
          external_id: 'professional:444@lid',
          name: '444@lid',
          push_name: null,
          source: 'participant',
        },
      ];
    }
    if (isResolve(sql) && ((params[1] as string[]) || []).includes('333@lid')) {
      return [{ id: 'professional:333@lid', external_id: '333@lid' }];
    }
    if (isAliasResolve(sql)) return [];
    return [];
  });
  try {
    // One person blocked under both identities (no Signal mapping: 008 knows),
    // another only by LID with a jid-like name.
    const fixture = provider({ blocked: ['333@lid', '34633333333@c.us', '444@lid'] });
    const client = makeClient(fixture);
    const first = await client.listBlockedContacts();
    assert.equal(first.cached, false);
    assert.deepEqual(first.blocked, [
      {
        id: '333@lid',
        jids: ['333@lid', '34633333333@s.whatsapp.net'],
        blockedJids: ['333@lid', '34633333333@s.whatsapp.net'],
        phone: '+34633333333',
        name: 'Lucía',
        pushName: 'Lu',
        conversationId: 'professional:333@lid',
      },
      {
        id: '444@lid',
        jids: ['444@lid'],
        blockedJids: ['444@lid'],
        phone: null,
        name: null,
        pushName: null,
        conversationId: null,
      },
    ]);
    assert.equal(fixture.state.reads, 1);
    const again = await client.listBlockedContacts();
    assert.equal(again.cached, true);
    assert.equal(fixture.state.reads, 1, 'a fresh cache is not re-read');
    await client.listBlockedContacts({ fresh: true });
    assert.equal(fixture.state.reads, 2);
    assert.equal(
      pool.calls.some(call => isWrite(call.sql)),
      false
    );
  } finally {
    pool.restore();
  }
});

test('client: a disconnected socket refuses the list and the change', async () => {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), {});
  await assert.rejects(client.listBlockedContacts(), /not initialized|not connected/);
  await assert.rejects(
    client.setContactBlock({ action: 'block', conversationId: '111@lid' }),
    /not initialized|not connected/
  );
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Call = (method: string, path: string, body?: unknown) => Promise<globalThis.Response>;

async function withRouter(
  client: Partial<BaileysClient>,
  env: Record<string, string | undefined>,
  run: (call: Call, port: number) => Promise<void>
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
    await run(call, port);
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
    setContactBlock: async (request: { action: string }, options?: { actor?: string }) => {
      seen.push({ ...request, ...options });
      return {
        action: request.action,
        blocked: request.action === 'block',
        changed: true,
        confirmed: true,
        jid: '111@lid',
        jids: ['111@lid'],
        conversationId: 'professional:111@lid',
      } as never;
    },
    listBlockedContacts: async (options: unknown) => {
      seen.push({ list: options });
      return { blocked: [{ id: '111@lid' }], readAt: 'now', cached: false } as never;
    },
  };
  return { client: client as unknown as Partial<BaileysClient>, seen };
}

const ON = { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined };
const BLOCK = { conversationId: 'professional:111@lid', action: 'block', confirm: true };

test('HTTP: 400s (confirm included) first, then the sending gate; the list is not gated', async () => {
  const { client, seen } = recordingClient();
  for (const env of [
    { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: undefined, EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' },
  ]) {
    await withRouter(client, env, async call => {
      for (const body of [
        { conversationId: '111@lid', action: 'block' },
        { conversationId: '120363@g.us', action: 'block', confirm: true },
        { action: 'block', confirm: true },
      ]) {
        const res = await call('POST', '/contacts/block', body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(
          ((await res.json()) as { failureClass: string }).failureClass,
          'invalid_request'
        );
      }
      const gated = await call('POST', '/contacts/block', BLOCK);
      assert.equal(gated.status, 403);
      assert.equal(
        ((await gated.json()) as { failureClass: string }).failureClass,
        'disabled_sending'
      );
      const list = await call('GET', '/contacts/blocklist');
      assert.equal(list.status, 200);
      assert.equal(((await list.json()) as { count: number }).count, 1);
    });
  }
  assert.deepEqual(seen, [
    { list: { fresh: false } },
    { list: { fresh: false } },
    { list: { fresh: false } },
  ]);
});

test('HTTP: block answers the confirmed state with the actor recorded; 503 offline; unsigned 401', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async (call, port) => {
    const res = await call('POST', '/contacts/block', { ...BLOCK, actor: 'dani' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      action: 'block',
      blocked: true,
      changed: true,
      confirmed: true,
      jid: '111@lid',
      jids: ['111@lid'],
      conversationId: 'professional:111@lid',
    });
    const fresh = await call('GET', '/contacts/blocklist?fresh=1');
    assert.equal(fresh.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/contacts/blocklist`)).status, 401);
  });
  assert.deepEqual(seen, [
    { action: 'block', conversationId: 'professional:111@lid', actor: 'dani' },
    { list: { fresh: true } },
  ]);
  const offline = recordingClient(false);
  await withRouter(offline.client, ON, async call => {
    assert.equal((await call('POST', '/contacts/block', BLOCK)).status, 503);
    assert.equal((await call('GET', '/contacts/blocklist')).status, 503);
  });
  assert.deepEqual(offline.seen, []);
});

test('HTTP: provider outcomes keep their status and failureClass', async () => {
  for (const [error, status, failureClass] of [
    [new ContactBlockError('no map', 422, 'identity_unresolved'), 422, 'identity_unresolved'],
    [
      new ContactBlockError('not confirmed', 409, 'block_not_confirmed'),
      409,
      'block_not_confirmed',
    ],
    [
      new ContactBlockError('unusable', 502, 'provider_invalid_response'),
      502,
      'provider_invalid_response',
    ],
  ] as const) {
    const client = {
      isConnected: () => true,
      setContactBlock: async () => {
        throw error;
      },
    } as unknown as Partial<BaileysClient>;
    await withRouter(client, ON, async call => {
      const res = await call('POST', '/contacts/block', BLOCK);
      assert.equal(res.status, status);
      assert.equal(((await res.json()) as { failureClass: string }).failureClass, failureClass);
    });
  }
});
