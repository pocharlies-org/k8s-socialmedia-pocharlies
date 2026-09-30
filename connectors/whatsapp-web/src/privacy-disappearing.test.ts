/**
 * Privacy settings and disappearing messages (fase 3 / PR-8): exact Baileys
 * names and values (anything else 400 before WhatsApp), `confirm: true` for a
 * privacy change (it changes the account for everyone), only WhatsApp's four
 * timers, the group rule (admin when the group restricts its settings), the
 * timer kept on the canonical conversation (014) and never replaced by an
 * older one, and the HTTP surface (signed body, sending gate, errors with
 * failureClass).
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test (same harness as group-management.test.ts).
 * Ported and adapted from the NAS fork's whatsapp-capabilities.test.ts
 * ("privacy update validates only provider-supported values") and
 * capabilities-client.test.ts ("disappearing mode reads USync…").
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
import { BaileysClient, BaileysClientOptions } from './baileys-client';
import {
  buildPrivacyUpdate,
  parsePrivacyRequest,
  PRIVACY_SETTINGS,
  privacyView,
} from './privacy-settings';
import {
  disappearingLabel,
  ephemeralFromBaileys,
  parseDisappearingExpiration,
  resetDisappearingStateForTests,
} from './disappearing';
import { GroupActionError } from './group-management';
import { MessageMutationError } from './message-mutations';
import { resetChatStateForTests } from './chat-state';
import { resetDurableStoreStateForTests } from './durable-message-store';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

interface QueryCall {
  sql: string;
  params: unknown[];
}

type Rows = Record<string, unknown>[];

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
  resetDisappearingStateForTests();
}

const isResolve = (sql: string): boolean => /WITH RECURSIVE hop/.test(sql);
const isTimerRead = (sql: string): boolean => /SELECT ephemeral_expiration/.test(sql);
const isTimerWrite = (sql: string): boolean => /SET ephemeral_expiration/.test(sql);

const ME_PN = '34600111222@s.whatsapp.net';
const ME_LID = '900@lid';
const PN = '34611111111@s.whatsapp.net';
const LID = '111@lid';
const GROUP = '120363000000000001@g.us';

/** The DB of a test: which chats are known, and the stored timer of each row. */
function db(
  timers: Record<string, { expiration: number | null; setAt?: string | null }> = {},
  options: { missingColumns?: boolean } = {}
): (sql: string, params: unknown[]) => Rows {
  return (sql, params) => {
    if (isResolve(sql)) {
      const candidates = (params[1] as string[]) || [];
      if (candidates.includes(LID)) return [{ id: `professional:${LID}`, external_id: LID }];
      if (candidates.includes('34611111111@c.us')) {
        // Merged: the PN twin was folded into its @lid conversation.
        return [{ id: `professional:${LID}`, external_id: LID }];
      }
      if (candidates.includes(GROUP)) return [{ id: `professional:${GROUP}`, external_id: GROUP }];
      return [];
    }
    if (isTimerRead(sql) || isTimerWrite(sql)) {
      if (options.missingColumns) {
        throw Object.assign(new Error('column "ephemeral_expiration" does not exist'), {
          code: '42703',
        });
      }
    }
    if (isTimerRead(sql)) {
      const row = timers[String(params[0])];
      return row
        ? [{ ephemeral_expiration: row.expiration, ephemeral_setting_at: row.setAt ?? null }]
        : [];
    }
    if (isTimerWrite(sql)) return [{}];
    return [];
  };
}

function groupMeta(
  options: {
    selfAdmin?: 'admin' | 'superadmin' | null;
    selfListed?: boolean;
    restrict?: boolean;
    community?: boolean;
    ephemeral?: number;
  } = {}
): any {
  return {
    id: GROUP,
    subject: 'Equipo',
    restrict: options.restrict ?? true,
    announce: false,
    isCommunity: options.community ?? false,
    ephemeralDuration: options.ephemeral,
    participants: [
      ...(options.selfListed === false
        ? []
        : [{ id: ME_LID, phoneNumber: ME_PN, admin: options.selfAdmin ?? null }]),
      { id: LID, phoneNumber: PN, admin: 'superadmin' },
    ],
  };
}

interface SockCalls {
  privacyReads: number;
  privacy: Array<[string, unknown]>;
  toggles: Array<[string, number]>;
  messages: Array<[string, unknown]>;
  usync: string[];
}

function makeClient(
  options: BaileysClientOptions = {},
  behaviour: {
    privacy?: Record<string, string>;
    meta?: () => any;
    usync?: () => any;
    privacyError?: unknown;
  } = {}
): { client: BaileysClient; calls: SockCalls; handlers: Record<string, (u: any) => unknown> } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const calls: SockCalls = { privacyReads: 0, privacy: [], toggles: [], messages: [], usync: [] };
  const handlers: Record<string, (u: any) => unknown> = {};
  let privacy = {
    last: 'contacts',
    online: 'all',
    profile: 'all',
    status: 'contacts',
    readreceipts: 'all',
    groupadd: 'all',
    calladd: 'all',
    messages: 'all',
    stickers: 'all',
    ...(behaviour.privacy || {}),
  };
  const setter = (category: string, method: string) => async (value: unknown) => {
    calls.privacy.push([method, value]);
    if (behaviour.privacyError) throw behaviour.privacyError;
    privacy = { ...privacy, [category]: String(value) };
  };
  const sock: Record<string, unknown> = {
    ev: {
      on: (event: string, fn: (u: any) => unknown) => {
        handlers[event] = fn;
      },
    },
    user: { id: '34600111222:5@s.whatsapp.net', lid: '900:5@lid' },
    authState: { creds: { me: { name: 'Dani' }, accountSettings: { unarchiveChats: false } } },
    signalRepository: {
      lidMapping: { getLIDForPN: async () => null, getPNForLID: async () => null },
    },
    fetchPrivacySettings: async (force?: boolean) => {
      assert.equal(force, true, 'never Baileys’ cached copy');
      calls.privacyReads += 1;
      return { ...privacy };
    },
    updateLastSeenPrivacy: setter('last', 'updateLastSeenPrivacy'),
    updateOnlinePrivacy: setter('online', 'updateOnlinePrivacy'),
    updateReadReceiptsPrivacy: setter('readreceipts', 'updateReadReceiptsPrivacy'),
    updateDefaultDisappearingMode: async (duration: number) => {
      calls.privacy.push(['updateDefaultDisappearingMode', duration]);
    },
    groupMetadata: async () => (behaviour.meta || (() => groupMeta()))(),
    groupToggleEphemeral: async (jid: string, expiration: number) => {
      calls.toggles.push([jid, expiration]);
    },
    sendMessage: async (jid: string, content: unknown) => {
      calls.messages.push([jid, content]);
      return { key: { id: 'X1', remoteJid: jid, fromMe: true } };
    },
    fetchDisappearingDuration: async (jid: string) => {
      calls.usync.push(jid);
      return behaviour.usync ? behaviour.usync() : undefined;
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

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

test('privacy update validates only provider-supported values (fork whatsapp-capabilities.test)', () => {
  assert.deepEqual(buildPrivacyUpdate('lastSeen', 'contacts'), {
    setting: 'lastSeen',
    value: 'contacts',
    method: 'updateLastSeenPrivacy',
  });
  assert.deepEqual(buildPrivacyUpdate('online', 'match_last_seen'), {
    setting: 'online',
    value: 'match_last_seen',
    method: 'updateOnlinePrivacy',
  });
  assert.deepEqual(buildPrivacyUpdate('defaultDisappearing', '7d'), {
    setting: 'defaultDisappearing',
    value: 604800,
    method: 'updateDefaultDisappearingMode',
  });
  for (const [setting, value] of [
    ['online', 'none'],
    ['online', 'contacts'],
    ['readReceipts', 'contacts'],
    ['groupsAdd', 'none'],
    ['call', 'contacts'],
    ['messages', 'none'],
    ['lastSeen', 'Contacts'],
    ['lastSeen', 'everyone'],
    ['lastSeen', ''],
    ['lastSeen', null],
    ['last', 'all'],
    ['toString', 'all'],
    ['__proto__', 'all'],
    ['', 'all'],
    ['defaultDisappearing', 3600],
  ] as const) {
    assert.throws(
      () => buildPrivacyUpdate(setting, value),
      (e: unknown) =>
        e instanceof MessageMutationError &&
        e.status === 400 &&
        e.failureClass === 'invalid_request',
      `${setting}=${String(value)}`
    );
  }
  // Every value we accept is one Baileys' types accept (Types/Chat.d.ts).
  assert.deepEqual(PRIVACY_SETTINGS.lastSeen.values, [
    'all',
    'contacts',
    'contact_blacklist',
    'none',
  ]);
  assert.deepEqual(PRIVACY_SETTINGS.groupsAdd.values, ['all', 'contacts', 'contact_blacklist']);
  assert.deepEqual(PRIVACY_SETTINGS.call.values, ['all', 'known']);
});

test('a privacy change needs confirm: true (after the setting and value are checked)', () => {
  assert.deepEqual(parsePrivacyRequest({ setting: 'readReceipts', value: 'none', confirm: true }), {
    setting: 'readReceipts',
    value: 'none',
    method: 'updateReadReceiptsPrivacy',
  });
  for (const confirm of [undefined, false, 'true', 1, 'yes']) {
    assert.throws(
      () => parsePrivacyRequest({ setting: 'readReceipts', value: 'none', confirm }),
      (e: unknown) =>
        e instanceof MessageMutationError && e.status === 400 && e.code === 'confirm_required',
      String(confirm)
    );
  }
  assert.throws(
    () => parsePrivacyRequest({ setting: 'readReceipts', value: 'contacts' }),
    (e: unknown) => e instanceof MessageMutationError && e.code === undefined,
    'a bad value says so before asking for the confirmation'
  );
});

test('privacy view: WhatsApp categories under API names; unknown ones apart; allowed values', () => {
  const view = privacyView(
    { last: 'contacts', readreceipts: 'none', stickers: 'all', x: 5 },
    86400
  );
  assert.equal(view.settings.lastSeen, 'contacts');
  assert.equal(view.settings.readReceipts, 'none');
  assert.equal(view.settings.online, null, 'not reported = null, not a guess');
  assert.deepEqual(view.other, { stickers: 'all' });
  assert.equal(view.defaultDisappearing, 86400);
  assert.deepEqual(view.allowed.defaultDisappearing, [0, 86400, 604800, 7776000]);
  assert.equal(privacyView(undefined, undefined).defaultDisappearing, null);
});

test('disappearing: only off / 24h / 7d / 90d, in seconds or by label', () => {
  assert.equal(parseDisappearingExpiration(0), 0);
  assert.equal(parseDisappearingExpiration(false), 0);
  assert.equal(parseDisappearingExpiration('off'), 0);
  assert.equal(parseDisappearingExpiration(86400), 86400);
  assert.equal(parseDisappearingExpiration('24h'), 86400);
  assert.equal(parseDisappearingExpiration('604800'), 604800);
  assert.equal(parseDisappearingExpiration('7D'), 604800);
  assert.equal(parseDisappearingExpiration(7776000), 7776000);
  for (const bad of [
    3600,
    172800,
    259200,
    -1,
    86400.5,
    '3d',
    'on',
    true,
    null,
    undefined,
    '',
    {},
  ]) {
    assert.throws(
      () => parseDisappearingExpiration(bad),
      (e: unknown) => e instanceof MessageMutationError && e.status === 400,
      String(bad)
    );
  }
  assert.equal(disappearingLabel(0), 'off');
  assert.equal(disappearingLabel(7776000), '90d');
  assert.equal(disappearingLabel(null), null);
});

test('Baileys chat objects: a change with null is off; a snapshot without the field says nothing', () => {
  assert.deepEqual(
    ephemeralFromBaileys(
      { id: PN, ephemeralExpiration: 604800, ephemeralSettingTimestamp: 1_790_000_000 },
      'change'
    ),
    { expiration: 604800, setAt: new Date(1_790_000_000 * 1000) }
  );
  assert.deepEqual(ephemeralFromBaileys({ id: PN, ephemeralExpiration: null }, 'change'), {
    expiration: 0,
    setAt: null,
  });
  assert.equal(ephemeralFromBaileys({ id: PN, ephemeralExpiration: null }, 'snapshot'), undefined);
  assert.equal(ephemeralFromBaileys({ id: PN, unreadCount: 2 }, 'change'), undefined);
  assert.deepEqual(
    ephemeralFromBaileys({ ephemeralExpiration: { low: 86400, high: 0 } }, 'snapshot'),
    { expiration: 86400, setAt: null }
  );
});

// ---------------------------------------------------------------------------
// Privacy: the client
// ---------------------------------------------------------------------------

test('privacy read is fresh from WhatsApp; a change reads first and skips an equal value', async () => {
  useAccount('professional');
  const { client, calls } = makeClient();
  const view = await client.getPrivacySettings();
  assert.equal(view.settings.lastSeen, 'contacts');
  assert.equal(view.defaultDisappearing, null);
  assert.equal(calls.privacyReads, 1);

  const same = await client.updatePrivacySetting('lastSeen', 'contacts', { actor: 'dani' });
  assert.equal(same.changed, false);
  assert.deepEqual(calls.privacy, [], 'nothing sent for an equal value');

  const changed = await client.updatePrivacySetting('lastSeen', 'none', { actor: 'dani' });
  assert.equal(changed.changed, true);
  assert.equal(changed.previous, 'contacts');
  assert.equal(changed.privacy?.settings.lastSeen, 'none', 'read back after the change');
  assert.deepEqual(calls.privacy, [['updateLastSeenPrivacy', 'none']]);

  await client.updatePrivacySetting('defaultDisappearing', 86400);
  assert.deepEqual(calls.privacy.at(-1), ['updateDefaultDisappearingMode', 86400]);

  await assert.rejects(client.updatePrivacySetting('online', 'none'), MessageMutationError);
  assert.equal(calls.privacy.length, 2, 'an invalid value never reaches WhatsApp');
});

test('a WhatsApp refusal of a privacy change is 422 rejected_by_whatsapp with its code', async () => {
  useAccount('professional');
  const { client } = makeClient(
    {},
    {
      privacyError: Object.assign(new Error('not-allowed'), {
        isBoom: true,
        output: { statusCode: 405 },
      }),
    }
  );
  await assert.rejects(
    client.updatePrivacySetting('online', 'match_last_seen'),
    (e: unknown) =>
      e instanceof MessageMutationError &&
      e.status === 422 &&
      e.failureClass === 'rejected_by_whatsapp' &&
      e.code === '405'
  );
});

// ---------------------------------------------------------------------------
// Disappearing: the client
// ---------------------------------------------------------------------------

test('group timer: not admin of a restricted group → 403 not_group_admin, nothing sent', async () => {
  useAccount('professional');
  const pool = stubPool(db());
  try {
    const { client, calls } = makeClient({}, { meta: () => groupMeta({ restrict: true }) });
    await assert.rejects(
      client.setDisappearing(GROUP, 604800),
      (e: unknown) =>
        e instanceof GroupActionError && e.status === 403 && e.failureClass === 'not_group_admin'
    );
    const read = await client.getDisappearing(GROUP);
    assert.equal(read.canChange, false);
    assert.equal(read.expiration, 0);
    assert.equal(read.source, 'group_metadata');
    assert.deepEqual(calls.toggles, []);
  } finally {
    pool.restore();
  }
});

test('group timer: a member may change it when the group is not restricted; admins always', async () => {
  useAccount('professional');
  const pool = stubPool(db());
  try {
    const member = makeClient({}, { meta: () => groupMeta({ restrict: false }) });
    const result = await member.client.setDisappearing(`professional:${GROUP}`, '7d', {
      actor: 'dani',
    });
    assert.deepEqual(result, {
      chatId: GROUP,
      conversationId: `professional:${GROUP}`,
      isGroup: true,
      expiration: 604800,
      label: '7d',
      previous: 0,
      changed: true,
      persisted: true,
    });
    assert.deepEqual(member.calls.toggles, [[GROUP, 604800]]);
    assert.deepEqual(member.calls.messages, [], 'a group timer is not a chat message');
    const write = pool.calls.find(c => isTimerWrite(c.sql));
    assert.deepEqual(write?.params.slice(0, 3), [
      `professional:${GROUP}`,
      'whatsapp:professional',
      604800,
    ]);

    const admin = makeClient(
      {},
      { meta: () => groupMeta({ selfAdmin: 'admin', ephemeral: 86400 }) }
    );
    const off = await admin.client.setDisappearing(GROUP, 0);
    assert.equal(off.previous, 86400);
    assert.deepEqual(admin.calls.toggles, [[GROUP, 0]]);

    const same = makeClient(
      {},
      { meta: () => groupMeta({ selfAdmin: 'admin', ephemeral: 86400 }) }
    );
    const unchanged = await same.client.setDisappearing(GROUP, 86400);
    assert.equal(unchanged.changed, false);
    assert.deepEqual(same.calls.toggles, [], 'an equal timer is not re-sent');
  } finally {
    pool.restore();
  }
});

test('group timer: not a member → 403 not_group_member; a community → 422', async () => {
  useAccount('professional');
  const pool = stubPool(db());
  try {
    const outsider = makeClient(
      {},
      { meta: () => groupMeta({ selfListed: false, restrict: false }) }
    );
    await assert.rejects(
      outsider.client.setDisappearing(GROUP, 86400),
      (e: unknown) => e instanceof GroupActionError && e.failureClass === 'not_group_member'
    );
    const community = makeClient(
      {},
      { meta: () => groupMeta({ selfAdmin: 'admin', community: true }) }
    );
    await assert.rejects(
      community.client.setDisappearing(GROUP, 86400),
      (e: unknown) => e instanceof GroupActionError && e.failureClass === 'community_unsupported'
    );
    assert.deepEqual([...outsider.calls.toggles, ...community.calls.toggles], []);
  } finally {
    pool.restore();
  }
});

test('direct timer: the timer message goes to the canonical chat and lands on its row', async () => {
  useAccount('professional');
  const pool = stubPool(db());
  try {
    const { client, calls } = makeClient();
    // The PN twin was merged into the @lid conversation: the change acts there.
    const result = await client.setDisappearing('professional:34611111111@c.us', 7776000, {
      actor: 'dani',
    });
    assert.equal(result.chatId, LID);
    assert.equal(result.conversationId, `professional:${LID}`);
    assert.equal(result.previous, null, 'never learnt');
    assert.equal(result.changed, true);
    assert.equal(result.persisted, true);
    assert.deepEqual(calls.messages, [[LID, { disappearingMessagesInChat: 7776000 }]]);
    const write = pool.calls.find(c => isTimerWrite(c.sql));
    assert.equal(write?.params[0], `professional:${LID}`);
    assert.equal(write?.params[2], 7776000);
    assert.ok(write?.params[3] instanceof Date);
    assert.match(String(write?.sql), /merged_into IS NULL/);
    await assert.rejects(
      client.setDisappearing('34699999999@c.us', 86400),
      (e: unknown) =>
        e instanceof MessageMutationError && e.failureClass === 'conversation_unavailable'
    );
    await assert.rejects(
      client.setDisappearing(PN, 3600),
      (e: unknown) => e instanceof MessageMutationError && e.status === 400
    );
    assert.equal(calls.messages.length, 1);
  } finally {
    pool.restore();
  }
});

test('direct timer: a known equal timer is not re-sent; without 014 it still goes out, persisted false', async () => {
  useAccount('professional');
  let pool = stubPool(
    db({ [`professional:${LID}`]: { expiration: 604800, setAt: '2026-09-01T00:00:00Z' } })
  );
  try {
    const { client, calls } = makeClient();
    const same = await client.setDisappearing(LID, 604800);
    assert.equal(same.changed, false);
    assert.equal(same.previous, 604800);
    assert.deepEqual(calls.messages, []);
  } finally {
    pool.restore();
  }
  useAccount('professional');
  pool = stubPool(db({}, { missingColumns: true }));
  try {
    const { client, calls } = makeClient();
    const sent = await client.setDisappearing(LID, 86400);
    assert.equal(sent.changed, true);
    assert.equal(sent.persisted, false);
    assert.equal(calls.messages.length, 1);
    const read = await client.getDisappearing(LID);
    assert.equal(read.known, false, 'missing columns read as unknown, not an error');
  } finally {
    pool.restore();
  }
});

test('disappearing read: stored timer of a direct chat; USync default reported apart (fork "disappearing mode reads USync")', async () => {
  useAccount('professional');
  const pool = stubPool(
    db({ [`professional:${LID}`]: { expiration: 86400, setAt: '2026-09-20T10:00:00.000Z' } })
  );
  try {
    const { client, calls } = makeClient(
      {},
      {
        usync: () => [
          { id: PN, disappearing_mode: { duration: 604800, setAt: new Date(1_790_000_000_000) } },
        ],
      }
    );
    const read = await client.getDisappearing(PN);
    assert.deepEqual(read, {
      chatId: LID,
      conversationId: `professional:${LID}`,
      isGroup: false,
      expiration: 86400,
      label: '24h',
      known: true,
      setAt: '2026-09-20T10:00:00.000Z',
      source: 'conversation',
      canChange: true,
      contactDefault: {
        expiration: 604800,
        label: '7d',
        setAt: new Date(1_790_000_000_000).toISOString(),
      },
    });
    assert.deepEqual(calls.usync, [LID]);
  } finally {
    pool.restore();
  }
  useAccount('professional');
  const empty = stubPool(db());
  try {
    const { client } = makeClient();
    const unknown = await client.getDisappearing(LID);
    assert.equal(unknown.known, false);
    assert.equal(unknown.expiration, null);
    assert.equal(unknown.source, 'unknown');
    assert.equal(unknown.contactDefault, null);
  } finally {
    empty.restore();
  }
});

test('inbound: a timer change lands on the canonical row; a snapshot only fills an unknown one', async () => {
  useAccount('professional');
  const pool = stubPool(db());
  try {
    const { client, handlers } = makeClient();
    priv(client).bindSocketEvents(async () => {});
    handlers['chats.update']([
      { id: PN, ephemeralExpiration: 604800, ephemeralSettingTimestamp: 1_790_000_000 },
    ]);
    handlers['chats.update']([
      { id: GROUP, ephemeralExpiration: null, ephemeralSettingTimestamp: 1_790_000_100 },
    ]);
    handlers['chats.update']([{ id: PN, unreadCount: 1 }]);
    handlers['chats.upsert']([{ id: LID, unreadCount: 0 }]);
    await settle();
    const writes = pool.calls.filter(c => isTimerWrite(c.sql));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].params.slice(0, 3), [
      `professional:${LID}`,
      'whatsapp:professional',
      604800,
    ]);
    assert.deepEqual(writes[0].params[3], new Date(1_790_000_000_000));
    assert.deepEqual(writes[1].params.slice(0, 3), [
      `professional:${GROUP}`,
      'whatsapp:professional',
      0,
    ]);
    // Never over a newer timer; a snapshot (no time) only fills a NULL one.
    assert.match(writes[0].sql, /ephemeral_setting_at <= \$4/);
    assert.match(writes[0].sql, /ephemeral_expiration IS NULL/);
  } finally {
    pool.restore();
  }
});

test('ingest off (the pairing pool): no chat handlers, no DB, a timer read is unknown', async () => {
  useAccount('professional');
  const pool = stubPool(db());
  try {
    const { client, handlers, calls } = makeClient({ ingest: false });
    priv(client).bindSocketEvents(async () => {});
    assert.equal(handlers['chats.update'], undefined);
    const read = await client.getDisappearing(PN);
    assert.equal(read.known, false);
    const set = await client.setDisappearing(PN, 86400);
    assert.equal(set.persisted, false);
    assert.equal(set.conversationId, null);
    assert.deepEqual(calls.messages, [[PN, { disappearingMessagesInChat: 86400 }]]);
    assert.deepEqual(pool.calls, [], 'no query at all');
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
    getPrivacySettings: async () => {
      seen.push('privacy-read');
      return { settings: { lastSeen: 'contacts' } } as never;
    },
    updatePrivacySetting: async (
      setting: unknown,
      value: unknown,
      request?: { actor?: string }
    ) => {
      seen.push({ privacy: setting, value, ...request });
      return { setting, value, previous: 'all', changed: true, privacy: null } as never;
    },
    getDisappearing: async (chatId: unknown) => {
      seen.push({ timerRead: chatId });
      return { chatId, expiration: 0 } as never;
    },
    setDisappearing: async (chatId: unknown, expiration: unknown, request?: { actor?: string }) => {
      seen.push({ timer: chatId, expiration, ...request });
      return { chatId, expiration, changed: true } as never;
    },
  };
  return { client: client as unknown as Partial<BaileysClient>, seen };
}

const ON = { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined };

test('HTTP: the sending gate blocks privacy / timer changes, not the reads; 400s come first', async () => {
  const { client, seen } = recordingClient();
  for (const env of [
    { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: undefined, EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' },
  ]) {
    await withRouter(client, env, async call => {
      for (const [path, body] of [
        ['/privacy', { setting: 'lastSeen', value: 'none', confirm: true }],
        ['/chats/disappearing', { conversationId: PN, expiration: 86400 }],
      ] as const) {
        const res = await call('POST', path, body);
        assert.equal(res.status, 403, path);
        assert.equal(
          ((await res.json()) as { failureClass: string }).failureClass,
          'disabled_sending'
        );
      }
      for (const [path, body] of [
        ['/privacy', { setting: 'lastSeen', value: 'none' }],
        ['/privacy', { setting: 'lastSeen', value: 'nobody', confirm: true }],
        ['/chats/disappearing', { conversationId: PN, expiration: 3600 }],
        ['/chats/disappearing', { expiration: 86400 }],
      ] as const) {
        const res = await call('POST', path, body);
        assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
      }
      assert.equal((await call('GET', '/privacy')).status, 200);
      assert.equal(
        (await call('POST', '/chats/disappearing/read', { conversationId: PN })).status,
        200
      );
    });
  }
  assert.deepEqual(seen, [
    'privacy-read',
    { timerRead: PN },
    'privacy-read',
    { timerRead: PN },
    'privacy-read',
    { timerRead: PN },
  ]);
});

test('HTTP: confirm missing is 400 confirm_required, never reaching the client', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async call => {
    const res = await call('POST', '/privacy', {
      setting: 'readReceipts',
      value: 'none',
      confirm: 'true',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'Privacy settings change the account for every contact: pass confirm: true',
      failureClass: 'invalid_request',
      code: 'confirm_required',
    });
  });
  assert.deepEqual(seen, []);
});

test('HTTP: 200 shapes carry the body values and the actor; 503 when disconnected', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async call => {
    const privacy = await call('POST', '/privacy', {
      setting: 'online',
      value: 'match_last_seen',
      confirm: true,
      actor: 'dani',
    });
    assert.deepEqual(await privacy.json(), {
      updated: true,
      setting: 'online',
      value: 'match_last_seen',
      previous: 'all',
      changed: true,
      privacy: null,
    });
    const timer = await call('POST', '/chats/disappearing', {
      conversationId: `professional:${GROUP}`,
      expiration: '90d',
      actor: 'dani',
    });
    assert.deepEqual(await timer.json(), {
      updated: true,
      chatId: `professional:${GROUP}`,
      expiration: 7776000,
      changed: true,
    });
    const read = await call('GET', '/privacy');
    assert.deepEqual(await read.json(), { privacy: { settings: { lastSeen: 'contacts' } } });
    const timerRead = await call('POST', '/chats/disappearing/read', { conversationId: GROUP });
    assert.deepEqual(await timerRead.json(), { disappearing: { chatId: GROUP, expiration: 0 } });
  });
  assert.deepEqual(seen, [
    { privacy: 'online', value: 'match_last_seen', actor: 'dani' },
    { timer: `professional:${GROUP}`, expiration: 7776000, actor: 'dani' },
    'privacy-read',
    { timerRead: GROUP },
  ]);

  const offline = recordingClient(false);
  await withRouter(offline.client, ON, async call => {
    for (const [method, path, body] of [
      ['GET', '/privacy', undefined],
      ['POST', '/privacy', { setting: 'online', value: 'all', confirm: true }],
      ['POST', '/chats/disappearing', { conversationId: PN, expiration: 0 }],
    ] as const) {
      const res = await call(method, path, body);
      assert.equal(res.status, 503, path);
    }
  });
  assert.deepEqual(offline.seen, []);
});

test('HTTP: group refusals map to status + failureClass', async () => {
  const failing = {
    isConnected: () => true,
    getCachedState: () => 'CONNECTED',
    setDisappearing: async () => {
      throw new GroupActionError('Only admins', 403, 'not_group_admin');
    },
  };
  await withRouter(failing as never, ON, async call => {
    const res = await call('POST', '/chats/disappearing', {
      conversationId: GROUP,
      expiration: 86400,
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'Only admins', failureClass: 'not_group_admin' });
  });
});
