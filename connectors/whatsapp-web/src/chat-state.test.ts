/**
 * Chat state (fase 3 / PR-5): archive / pin / mute / read-unread through
 * POST /chats/modify, what it writes on the canonical conversation, what the
 * phone's chats.update writes, and the fail-soft path while migration 012 is
 * missing.
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test (same harness as message-mutations.test.ts).
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
import {
  BaileysClient,
  BaileysClientOptions,
  buildChatModification,
  normalizeChatModifyAction,
} from './baileys-client';
import {
  MessageUnavailableError,
  resetDurableStoreStateForTests,
  serializeDurableValue,
  toDurablePayload,
} from './durable-message-store';
import { MessageMutationError } from './message-mutations';
import {
  muteEndTimestamp,
  muteFromBaileys,
  pinFromBaileys,
  resetChatStateForTests,
} from './chat-state';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

interface QueryCall {
  sql: string;
  params: unknown[];
}

type Rows = Record<string, unknown>[];

/** Stub pg.Pool#query; `route` returns rows or throws (an error with `code`). */
function stubPool(route: (sql: string, params: unknown[]) => Rows = () => []): {
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
}

function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code });
}

const isResolve = (sql: string): boolean => /WITH RECURSIVE hop/.test(sql);
const isAliasResolve = (sql: string): boolean => /FROM social_contact_aliases/.test(sql);
const isLatest = (sql: string): boolean =>
  /SELECT m\.wa_message_id\s+FROM messages m\s+WHERE m\.conversation_id/.test(sql);
const isStoredSelect = (sql: string): boolean =>
  /FROM messages m\s+LEFT JOIN whatsapp_message_keys/i.test(sql);
const isPayloadSelect = (sql: string): boolean =>
  /FROM whatsapp_message_payloads/i.test(sql) && /SELECT/i.test(sql);
const isChatStateWrite = (sql: string): boolean =>
  /^\s*UPDATE conversations/.test(sql) && /merged_into IS NULL/.test(sql);
const chatStateWrites = (calls: QueryCall[]): QueryCall[] =>
  calls.filter(c => isChatStateWrite(c.sql));
const legacyStateWrites = (calls: QueryCall[]): QueryCall[] =>
  calls.filter(c => /^\s*UPDATE conversations/.test(c.sql) && !isChatStateWrite(c.sql));

/** The row writeChatState's RETURNING yields. */
function stateRow(overrides: Record<string, unknown> = {}): Rows {
  return [
    {
      archived: false,
      unread_count: 0,
      pinned_at: null,
      muted: false,
      mute_until: null,
      ...overrides,
    },
  ];
}

/** messages row + its whatsapp_message_keys columns (the PR-3 stored lookup). */
function storedRow(overrides: Record<string, unknown> = {}): Rows {
  return [
    {
      wa_message_id: 'professional:LAST1',
      conversation_id: 'professional:111@lid',
      sender_wa_id: 'professional:111@lid',
      direction: 'INBOUND',
      message_type: 'TEXT',
      content: 'hola',
      is_deleted: false,
      deleted_for_me: false,
      wa_timestamp: new Date(1_700_000_000_000),
      remote_jid: '111@lid',
      from_me: false,
      participant_jid: null,
      message_timestamp_ms: '1700000000000',
      ...overrides,
    },
  ];
}

/**
 * A professional DB: 34600@c.us is a tombstone merged into 111@lid, whose
 * newest message LAST1 is only known from its messages / keys rows.
 */
function canonicalDb(
  extra: (sql: string, params: unknown[]) => Rows | undefined = () => undefined
): (sql: string, params: unknown[]) => Rows {
  return (sql, params) => {
    const override = extra(sql, params);
    if (override) return override;
    if (isResolve(sql)) return [{ id: 'professional:111@lid', external_id: '111@lid' }];
    if (isLatest(sql)) return [{ wa_message_id: 'professional:LAST1' }];
    if (isStoredSelect(sql)) return storedRow();
    if (isChatStateWrite(sql)) return stateRow();
    return [];
  };
}

interface SockCalls {
  modified: Array<{ mod: any; jid: string }>;
  read: any[][];
}

function makeClient(
  options: BaileysClientOptions = {},
  behaviour: { chatModifyError?: unknown } = {}
): { client: BaileysClient; calls: SockCalls; handlers: Record<string, (u: any) => unknown> } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const calls: SockCalls = { modified: [], read: [] };
  const handlers: Record<string, (u: any) => unknown> = {};
  const sock = {
    ev: {
      on: (event: string, fn: (u: any) => unknown) => {
        handlers[event] = fn;
      },
    },
    chatModify: async (mod: any, jid: string) => {
      calls.modified.push({ mod, jid });
      if (behaviour.chatModifyError) throw behaviour.chatModifyError;
    },
    readMessages: async (keys: any[]) => {
      calls.read.push(keys);
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

/** Let the fire-and-forget writes of an event handler settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// The Baileys contract (ported from the NAS fork's whatsapp-capabilities test)
// ---------------------------------------------------------------------------

test('chat modifications use the Baileys lastMessages contract', () => {
  const key = { remoteJid: '34600@s.whatsapp.net', id: 'msg-1', fromMe: false };
  const lastMessages = [{ key, messageTimestamp: 123 }];

  assert.deepEqual(buildChatModification('archive', { lastMessages }), {
    archive: true,
    lastMessages,
  });
  assert.deepEqual(buildChatModification('unarchive', { lastMessages }), {
    archive: false,
    lastMessages,
  });
  assert.deepEqual(buildChatModification('markRead', { lastMessages }), {
    markRead: true,
    lastMessages,
  });
  assert.deepEqual(buildChatModification('markUnread', { lastMessages }), {
    markRead: false,
    lastMessages,
  });
  assert.deepEqual(buildChatModification('pin'), { pin: true });
  assert.deepEqual(buildChatModification('unpin'), { pin: false });
  // WhatsApp's muteEndTimestamp is an absolute epoch in ms (-1 = always),
  // not the duration the NAS fork passed through.
  const until = new Date('2026-10-01T10:00:00Z');
  assert.deepEqual(buildChatModification('mute', { mute: { until } }), {
    mute: until.getTime(),
  });
  assert.deepEqual(buildChatModification('mute', { mute: { until: null } }), { mute: -1 });
  assert.deepEqual(buildChatModification('unmute'), { mute: null });
  assert.throws(
    () => buildChatModification('archive', { lastMessages: [] }),
    (error: unknown) =>
      error instanceof MessageUnavailableError && error.failureClass === 'message_unavailable'
  );
});

test('action spellings normalise; star is not a chat action', () => {
  assert.equal(normalizeChatModifyAction('markRead'), 'markRead');
  assert.equal(normalizeChatModifyAction('mark-read'), 'markRead');
  assert.equal(normalizeChatModifyAction('mark_unread'), 'markUnread');
  assert.equal(normalizeChatModifyAction('unread'), 'markUnread');
  assert.equal(normalizeChatModifyAction(' Archive '), 'archive');
  assert.equal(normalizeChatModifyAction('star'), null);
  assert.equal(normalizeChatModifyAction('delete'), null);
  assert.equal(normalizeChatModifyAction(3), null);
});

test('pin / mute of Baileys chat objects: sync actions vs snapshots', () => {
  assert.equal(pinFromBaileys({ id: 'x' }), undefined);
  assert.equal(pinFromBaileys({ pinned: null }), null);
  assert.equal(pinFromBaileys({ pinned: 0 }), null);
  assert.equal(pinFromBaileys({ pinned: 1727510400 })?.toISOString(), '2024-09-28T08:00:00.000Z');
  assert.equal(pinFromBaileys({ pinned: 1727510400000 })?.toISOString(), '2024-09-28T08:00:00.000Z');
  assert.equal(pinFromBaileys({ pinned: -1 }), undefined);

  assert.equal(muteFromBaileys({ id: 'x' }, 'sync-action'), undefined);
  assert.equal(muteFromBaileys({ muteEndTime: null }, 'sync-action'), null);
  assert.deepEqual(muteFromBaileys({ muteEndTime: 0 }, 'sync-action'), { until: null });
  assert.deepEqual(muteFromBaileys({ muteEndTime: -1 }, 'sync-action'), { until: null });
  assert.deepEqual(muteFromBaileys({ muteEndTime: 1790000000000 }, 'sync-action'), {
    until: new Date(1790000000000),
  });
  assert.equal(muteFromBaileys({ muteEndTime: 0 }, 'snapshot'), null);
  assert.equal(muteFromBaileys({ muteEndTime: null }, 'snapshot'), undefined);
  // protobuf Long from a history snapshot
  assert.deepEqual(muteFromBaileys({ muteEndTime: { low: 1790000000, high: 0 } }, 'snapshot'), {
    until: new Date(1790000000 * 1000),
  });
  assert.equal(muteEndTimestamp({ until: null }), -1);
});

// ---------------------------------------------------------------------------
// Outbound: key resolution, the canonical row, what each action writes
// ---------------------------------------------------------------------------

test('archive after a restart takes lastMessages from the durable keys and goes to the key’s jid', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(canonicalDb());
  try {
    const { client, calls: sock } = makeClient();
    // Tombstone PN id in the request; memory is empty (a fresh process).
    const result = await client.modifyChat('professional:34600@c.us', 'archive');
    assert.equal(sock.modified.length, 1);
    assert.equal(sock.modified[0].jid, '111@lid');
    assert.deepEqual(sock.modified[0].mod, {
      archive: true,
      lastMessages: [
        {
          key: { remoteJid: '111@lid', id: 'LAST1', fromMe: false, participant: undefined },
          messageTimestamp: 1_700_000_000,
        },
      ],
    });
    // Resolved by (account_id, both phone suffixes) following merged_into.
    const resolve = calls.find(c => isResolve(c.sql))!;
    assert.deepEqual(resolve.params, [
      'whatsapp:professional',
      ['34600@c.us', '34600@s.whatsapp.net'],
      8,
    ]);
    const latest = calls.find(c => isLatest(c.sql))!;
    assert.deepEqual(latest.params, ['professional:111@lid', 'whatsapp:professional']);
    // Written on the canonical row only.
    const [write] = chatStateWrites(calls);
    assert.match(write.sql, /archived = \$3/);
    assert.deepEqual(write.params, ['professional:111@lid', 'whatsapp:professional', true]);
    assert.deepEqual(result, {
      action: 'archive',
      chatId: '111@lid',
      conversationId: 'professional:111@lid',
      persisted: true,
      state: { archived: false, unreadCount: 0, pinnedAt: null, muted: false, muteUntil: null },
    });
  } finally {
    restore();
  }
});

test('the durable payload key wins (group message of a contact keeps its participant)', async () => {
  useAccount('personal');
  const { restore } = stubPool(
    canonicalDb((sql, params) => {
      if (isResolve(sql)) return [{ id: '120363000@g.us', external_id: '120363000@g.us' }];
      if (isLatest(sql)) return [{ wa_message_id: 'G1' }];
      if (isStoredSelect(sql)) return [];
      if (isPayloadSelect(sql) && params[0] === 'G1')
        return [
          {
            message_key: JSON.parse(
              serializeDurableValue({
                remoteJid: '120363000@g.us',
                id: 'G1',
                fromMe: false,
                participant: '4455@lid',
              })
            ),
            message_payload: JSON.parse(serializeDurableValue(toDurablePayload({ conversation: 'x' }))),
            wa_timestamp: new Date(1_700_000_500_000),
            push_name: null,
          },
        ];
      return undefined;
    })
  );
  try {
    const { client, calls: sock } = makeClient();
    await client.modifyChat('120363000@g.us', 'markUnread');
    assert.deepEqual(sock.modified[0], {
      jid: '120363000@g.us',
      mod: {
        markRead: false,
        lastMessages: [
          {
            key: { remoteJid: '120363000@g.us', id: 'G1', fromMe: false, participant: '4455@lid' },
            messageTimestamp: 1_700_000_500,
          },
        ],
      },
    });
  } finally {
    restore();
  }
});

test('each action writes its own columns on the canonical row', async () => {
  useAccount('professional');
  const until = new Date(Date.now() + 3_600_000);
  const cases: Array<{
    action: Parameters<BaileysClient['modifyChat']>[1];
    mute?: { until: Date | null };
    sets: RegExp[];
    params: unknown[];
    mod: unknown;
  }> = [
    { action: 'unarchive', sets: [/archived = \$3/], params: [false], mod: { archive: false } },
    { action: 'pin', sets: [/pinned_at = \$3::timestamptz/], params: ['date'], mod: { pin: true } },
    { action: 'unpin', sets: [/pinned_at = \$3::timestamptz/], params: [null], mod: { pin: false } },
    {
      action: 'mute',
      mute: { until },
      sets: [/muted = \$3/, /mute_until = \$4::timestamptz/],
      params: [true, until],
      mod: { mute: until.getTime() },
    },
    {
      action: 'mute',
      mute: { until: null },
      sets: [/muted = \$3/, /mute_until = \$4::timestamptz/],
      params: [true, null],
      mod: { mute: -1 },
    },
    {
      action: 'unmute',
      sets: [/muted = \$3/, /mute_until = \$4::timestamptz/],
      params: [false, null],
      mod: { mute: null },
    },
    {
      action: 'markUnread',
      sets: [/unread_count = GREATEST\(unread_count, 1\)/],
      params: [],
      mod: { markRead: false },
    },
  ];
  for (const c of cases) {
    const { calls, restore } = stubPool(canonicalDb());
    try {
      const { client, calls: sock } = makeClient();
      await client.modifyChat('34600@c.us', c.action, { mute: c.mute });
      const writes = chatStateWrites(calls);
      assert.equal(writes.length, 1, c.action);
      for (const set of c.sets) assert.match(writes[0].sql, set, c.action);
      assert.match(writes[0].sql, /WHERE id = \$1 AND account_id = \$2 AND merged_into IS NULL/);
      const extra = writes[0].params.slice(2);
      assert.equal(extra.length, c.params.length, c.action);
      c.params.forEach((expected, i) => {
        if (expected === 'date') assert.ok(extra[i] instanceof Date, c.action);
        else assert.deepEqual(extra[i], expected, c.action);
      });
      assert.equal(writes[0].params[0], 'professional:111@lid');
      const mod = sock.modified[0].mod;
      for (const [k, v] of Object.entries(c.mod as Record<string, unknown>)) {
        assert.deepEqual(mod[k], v, `${c.action}.${k}`);
      }
    } finally {
      restore();
    }
  }
});

test('markRead sends the read receipts, then the app-state mark, and clears the badge', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(
    canonicalDb(sql => {
      if (/WITH conv AS/.test(sql))
        return [
          {
            wa_message_id: 'professional:LAST1',
            remote_jid: '111@lid',
            from_me: false,
            participant_jid: null,
          },
        ];
      return undefined;
    })
  );
  try {
    const { client, calls: sock } = makeClient();
    await client.modifyChat('34600@c.us', 'markRead');
    assert.deepEqual(sock.read, [[{ id: 'LAST1', remoteJid: '111@lid', fromMe: false, participant: undefined }]]);
    assert.equal(sock.modified[0].mod.markRead, true);
    const [write] = chatStateWrites(calls);
    assert.match(write.sql, /unread_count = 0, unread_mentions = 0/);
  } finally {
    restore();
  }
});

test('a tombstone with no row of its own resolves through social_contact_aliases', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(
    canonicalDb(sql => {
      if (isResolve(sql)) return [];
      if (isAliasResolve(sql)) return [{ id: 'professional:111@lid', external_id: '111@lid' }];
      return undefined;
    })
  );
  try {
    const { client } = makeClient();
    const result = await client.modifyChat('34600@s.whatsapp.net', 'pin');
    assert.equal(result.conversationId, 'professional:111@lid');
    const alias = calls.find(c => isAliasResolve(c.sql))!;
    assert.match(alias.sql, /evidence <> 'blocked'/);
    assert.deepEqual(alias.params, [
      'whatsapp:professional',
      ['34600@c.us', '34600@s.whatsapp.net'],
    ]);
    assert.equal(chatStateWrites(calls)[0].params[0], 'professional:111@lid');
  } finally {
    restore();
  }
});

test('an unknown conversation is 404 conversation_unavailable; archive without a message is 404 message_unavailable', async () => {
  useAccount('personal');
  let known = false;
  const { calls, restore } = stubPool(sql => {
    if (isResolve(sql)) return known ? [{ id: '34600@c.us', external_id: '34600@c.us' }] : [];
    return [];
  });
  try {
    const { client, calls: sock } = makeClient();
    await assert.rejects(
      client.modifyChat('34600@c.us', 'pin'),
      (e: unknown) => e instanceof MessageMutationError && e.failureClass === 'conversation_unavailable'
    );
    known = true;
    await assert.rejects(
      client.modifyChat('34600@c.us', 'archive'),
      (e: unknown) => e instanceof MessageUnavailableError && e.failureClass === 'message_unavailable'
    );
    assert.equal(sock.modified.length, 0);
    assert.equal(chatStateWrites(calls).length, 0);
  } finally {
    restore();
  }
});

test('a WhatsApp refusal of the patch is 422 rejected_by_whatsapp and writes nothing', async () => {
  useAccount('professional');
  const boom = Object.assign(new Error('conflict'), { isBoom: true, output: { statusCode: 409 } });
  const { calls, restore } = stubPool(canonicalDb());
  try {
    const { client } = makeClient({}, { chatModifyError: boom });
    await assert.rejects(
      client.modifyChat('34600@c.us', 'pin'),
      (e: unknown) =>
        e instanceof MessageMutationError && e.failureClass === 'rejected_by_whatsapp' && e.code === '409'
    );
    assert.equal(chatStateWrites(calls).length, 0);
  } finally {
    restore();
  }
});

test('with ingest off nothing is read or written (the pairing pool)', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(canonicalDb());
  try {
    const { client, calls: sock } = makeClient({ ingest: false });
    const result = await client.modifyChat('34600@c.us', 'mute', { mute: { until: null } });
    assert.deepEqual(sock.modified, [{ jid: '34600@s.whatsapp.net', mod: { mute: -1 } }]);
    assert.deepEqual(result, {
      action: 'mute',
      chatId: '34600@c.us',
      conversationId: null,
      persisted: false,
      state: null,
    });
    // archive / read need a durable key: without ingest there is none.
    await assert.rejects(client.modifyChat('34600@c.us', 'archive'), MessageUnavailableError);
    await assert.rejects(client.modifyChat('34600@c.us', 'markRead'), MessageUnavailableError);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Migration 012 missing → fail soft
// ---------------------------------------------------------------------------

test('without migration 012: pin reaches WhatsApp unrecorded, archive still records, re-probe waits', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(
    canonicalDb(sql => {
      if (/^\s*UPDATE conversations/.test(sql) && /pinned_at|muted/.test(sql)) {
        throw pgError('42703');
      }
      if (isChatStateWrite(sql)) return [{ archived: true, unread_count: 2 }];
      return undefined;
    })
  );
  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const { client, calls: sock, handlers } = makeClient();
    const pinned = await client.modifyChat('34600@c.us', 'pin');
    assert.equal(sock.modified.length, 1);
    assert.equal(pinned.persisted, false);
    assert.equal(pinned.state, null);

    // Known missing now: the next pin does not even try the UPDATE…
    const before = chatStateWrites(calls).length;
    await client.modifyChat('34600@c.us', 'unpin');
    assert.equal(chatStateWrites(calls).length, before);
    // …inbound pins are skipped, and archive records with the legacy readback.
    priv(client).bindSocketEvents(async () => {});
    await handlers['chats.update']([{ id: '34600@s.whatsapp.net', pinned: 1727510400000 }]);
    await settle();
    assert.equal(chatStateWrites(calls).length, before);
    const archived = await client.modifyChat('34600@c.us', 'archive');
    assert.deepEqual(archived.state, { archived: true, unreadCount: 2 });
    assert.match(chatStateWrites(calls).at(-1)!.sql, /RETURNING archived, unread_count$/);
    assert.equal(warnings.length, 1, 'logged once');
  } finally {
    console.warn = warn;
    restore();
  }
});

// ---------------------------------------------------------------------------
// Inbound: what the phone does
// ---------------------------------------------------------------------------

test('chats.update from the phone: pin / mute on the canonical row, marked-unread keeps a badge', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(canonicalDb());
  try {
    const { client, handlers } = makeClient();
    priv(client).bindSocketEvents(async () => {});
    await handlers['chats.update']([
      { id: '34600@s.whatsapp.net', pinned: 1727510400000 },
      { id: '34600@s.whatsapp.net', muteEndTime: 0 },
      { id: '34600@s.whatsapp.net', muteEndTime: null },
      { id: '34600@s.whatsapp.net', unreadCount: -1 },
      { id: '34600@s.whatsapp.net', archived: true },
    ]);
    await settle();
    const writes = chatStateWrites(calls);
    assert.equal(writes.length, 3);
    assert.ok(writes.every(w => w.params[0] === 'professional:111@lid'));
    assert.deepEqual(writes[0].params.slice(2), [new Date(1727510400000)]);
    assert.deepEqual(writes[1].params.slice(2), [true, null]); // muted, forever
    assert.deepEqual(writes[2].params.slice(2), [false, null]); // unmuted
    // archived / unread stay on setConversationState (the /chats/resync-state path).
    const legacy = legacyStateWrites(calls);
    assert.equal(legacy.length, 2);
    assert.match(legacy[0].sql, /unread_count = GREATEST\(unread_count, 1\)/);
    // An archive-only delta of a chat not cached here leaves the badge alone.
    assert.doesNotMatch(legacy[1].sql, /unread_count/);
    assert.deepEqual(legacy[1].params, ['professional:34600@c.us', true]);
    assert.match(legacy[1].sql, /^UPDATE conversations SET archived = \$2, updated_at = now\(\) WHERE id = \$1$/);
  } finally {
    restore();
  }
});

test('history / chats.upsert snapshots record only the pins and mutes they carry', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(
    canonicalDb(sql => (isResolve(sql) ? [{ id: '34600@c.us', external_id: '34600@c.us' }] : undefined))
  );
  try {
    const { client, handlers } = makeClient();
    priv(client).bindSocketEvents(async () => {});
    await handlers['chats.upsert']([
      { id: '34600@s.whatsapp.net', pinned: 1727510400, muteEndTime: { low: 1790000000, high: 0 } },
      { id: '34611@s.whatsapp.net' },
    ]);
    await settle();
    const writes = chatStateWrites(calls);
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /pinned_at = \$3::timestamptz, muted = \$4, mute_until = \$5/);
    assert.deepEqual(writes[0].params, [
      '34600@c.us',
      'whatsapp:personal',
      new Date(1727510400 * 1000),
      true,
      new Date(1790000000 * 1000),
    ]);
  } finally {
    restore();
  }
});

test('ingest off binds no chat handlers at all', () => {
  useAccount('personal');
  const { client, handlers } = makeClient({ ingest: false });
  priv(client).bindSocketEvents(async () => {});
  assert.equal(handlers['chats.update'], undefined);
  assert.equal(handlers['chats.upsert'], undefined);
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
  const qr = { getCurrentQR: () => null };
  app.use('/api/v1', createRouter(client as BaileysClient, qr as never, secret));
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

function recordingClient(): { client: Partial<BaileysClient>; seen: unknown[] } {
  const seen: unknown[] = [];
  const client = {
    isConnected: () => true,
    getCachedState: () => 'CONNECTED',
    modifyChat: async (chatId: string, action: string, request?: { mute?: unknown; actor?: string }) => {
      seen.push({ chatId, action, ...request });
      return {
        action,
        chatId: '111@lid',
        conversationId: 'professional:111@lid',
        persisted: true,
        state: { archived: true, unreadCount: 0, pinnedAt: null, muted: false, muteUntil: null },
      };
    },
  };
  return { client: client as unknown as Partial<BaileysClient>, seen };
}

const ON = { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined };

test('HTTP: the sending gate blocks every chat action before WhatsApp', async () => {
  const { client, seen } = recordingClient();
  for (const env of [
    { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' },
  ]) {
    await withRouter(client, env, async call => {
      for (const action of ['archive', 'pin', 'mute', 'markRead', 'markUnread']) {
        const res = await call('POST', '/chats/modify', { conversationId: '34600@c.us', action });
        assert.equal(res.status, 403);
        assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'disabled_sending');
      }
    });
  }
  assert.deepEqual(seen, []);
});

test('HTTP: 200 shape, mute parameters and the actor', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async call => {
    const res = await call('POST', '/chats/modify', {
      conversationId: 'professional:34600@c.us',
      action: 'archive',
      actor: ' dani ',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      modified: true,
      action: 'archive',
      chatId: '111@lid',
      conversationId: 'professional:111@lid',
      persisted: true,
      state: { archived: true, unreadCount: 0, pinnedAt: null, muted: false, muteUntil: null },
    });
    const before = Date.now();
    await call('POST', '/chats/modify', { chatId: '34600@c.us', action: 'mute', durationMs: 3_600_000 });
    const after = Date.now();
    await call('POST', '/chats/modify', { chatId: '34600@c.us', action: 'mute' });
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await call('POST', '/chats/modify', { chatId: '34600@c.us', action: 'mute', muteUntil: until });
    // Mute parameters are ignored by the other actions.
    await call('POST', '/chats/modify', { chatId: '34600@c.us', action: 'mark-unread', durationMs: 5 });
    const timed = (seen[1] as { mute: { until: Date } }).mute.until.getTime();
    assert.ok(timed >= before + 3_600_000 && timed <= after + 3_600_000);
    assert.deepEqual((seen[2] as { mute: unknown }).mute, { until: null });
    assert.deepEqual((seen[3] as { mute: unknown }).mute, { until: new Date(until) });
  });
  assert.deepEqual(seen[0], {
    chatId: 'professional:34600@c.us',
    action: 'archive',
    mute: undefined,
    actor: 'dani',
  });
  assert.deepEqual(seen[4], {
    chatId: '34600@c.us',
    action: 'markUnread',
    mute: undefined,
    actor: undefined,
  });
  assert.equal(seen.length, 5);
});

test('HTTP: 400 on bad input, 503 when disconnected, errors mapped with failureClass', async () => {
  const { client, seen } = recordingClient();
  let failure: Error | null = null;
  let connected = true;
  Object.assign(client, {
    isConnected: () => connected,
    modifyChat: async () => {
      if (failure) throw failure;
      seen.push('called');
      return {};
    },
  });
  await withRouter(client, ON, async call => {
    const bad = async (body: unknown): Promise<void> => {
      const res = await call('POST', '/chats/modify', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'invalid_request');
    };
    await bad({ action: 'archive' });
    await bad({ conversationId: '34600@c.us' });
    await bad({ conversationId: '34600@c.us', action: 'star' });
    await bad({ conversationId: '34600@c.us', action: 'mute', durationMs: 0 });
    await bad({ conversationId: '34600@c.us', action: 'mute', durationMs: 1.5 });
    await bad({ conversationId: '34600@c.us', action: 'mute', durationMs: 'x' });
    await bad({ conversationId: '34600@c.us', action: 'mute', muteUntil: '2001-01-01T00:00:00Z' });
    await bad({ conversationId: '34600@c.us', action: 'mute', muteUntil: '2099-01-01T00:00:00Z' });
    await bad({ conversationId: '34600@c.us', action: 'mute', durationMs: 60_000, muteUntil: Date.now() + 60_000 });

    failure = new MessageMutationError('who?', 404, 'conversation_unavailable');
    const unknown = await call('POST', '/chats/modify', { conversationId: 'x@c.us', action: 'pin' });
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { failureClass: string }).failureClass, 'conversation_unavailable');

    failure = new MessageUnavailableError('no key', 404, 'message_unavailable');
    const noKey = await call('POST', '/chats/modify', { conversationId: 'x@c.us', action: 'archive' });
    assert.equal(((await noKey.json()) as { failureClass: string }).failureClass, 'message_unavailable');

    failure = new MessageMutationError('nope', 422, 'rejected_by_whatsapp', '409');
    const rejected = await call('POST', '/chats/modify', { conversationId: 'x@c.us', action: 'pin' });
    assert.equal(rejected.status, 422);
    assert.deepEqual(await rejected.json(), {
      error: 'nope',
      failureClass: 'rejected_by_whatsapp',
      code: '409',
    });

    connected = false;
    const offline = await call('POST', '/chats/modify', { conversationId: 'x@c.us', action: 'pin' });
    assert.equal(offline.status, 503);
    assert.equal(((await offline.json()) as { failureClass: string }).failureClass, 'disconnected');
  });
  assert.deepEqual(seen, []);
});
