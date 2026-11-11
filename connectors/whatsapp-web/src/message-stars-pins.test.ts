/**
 * Starred and pinned messages: the WhatsApp shapes (star app-state patch, pin
 * message), the BaileysClient paths (outbound star / pin after a restart,
 * inbound stars from our phone, pins from anyone, history stars) and the HTTP
 * routes (gate, 400 / 503, lists ungated).
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test (same harness as message-mutations.test.ts).
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// The star patch is off by default (WA_STAR_ENABLED, 01-10 device_removed); these
// tests exercise the patch itself, so they turn it on. The disabled path has its own test.
process.env.WA_STAR_ENABLED = 'true';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import pg from 'pg';
import { proto } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysClient, BaileysClientOptions } from './baileys-client';
import { MessageUnavailableError, resetDurableStoreStateForTests } from './durable-message-store';
import { MessageMutationError } from './message-mutations';
import {
  encodeStarredCursor,
  parsePinRequest,
  parseStarredQuery,
  parseStarRequest,
  pinActionOf,
  resetStarPinStoreStateForTests,
  starPatch,
} from './message-stars-pins';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

interface QueryCall {
  sql: string;
  params: unknown[];
}
type Rows = Record<string, unknown>[];

function stubPool(route: (sql: string, params: unknown[]) => Rows | Error = () => []): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    const out = route(sql, params);
    return out instanceof Error
      ? Promise.reject(out)
      : Promise.resolve({ rows: out, rowCount: out.length });
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
  resetStarPinStoreStateForTests();
}

const isStoredSelect = (sql: string): boolean =>
  /FROM messages m\s+LEFT JOIN whatsapp_message_keys/i.test(sql);
const isStarInsert = (sql: string): boolean => /INSERT INTO whatsapp_message_stars/i.test(sql);
const isPinInsert = (sql: string): boolean => /INSERT INTO whatsapp_message_pins/i.test(sql);
const isMessageInsert = (sql: string): boolean => /INSERT INTO messages/i.test(sql);
const isPayloadInsert = (sql: string): boolean =>
  /INSERT INTO whatsapp_message_payloads/i.test(sql);
const isConversationSelect = (sql: string): boolean =>
  /FROM conversations c\s+WHERE c\.account_id/i.test(sql);

function missingTable(name: string): Error {
  return Object.assign(new Error(`relation "${name}" does not exist`), { code: '42P01' });
}

const GROUP = '120363000@g.us';
const ME_PN = '34999@s.whatsapp.net';
const NOW_MS = 1_790_000_000_000;

/** A messages row (+ its whatsapp_message_keys columns) as loadStoredMessage selects it. */
function storedRow(overrides: Record<string, unknown> = {}): Rows {
  return [
    {
      wa_message_id: 'professional:M1',
      conversation_id: 'professional:34600@c.us',
      sender_wa_id: 'professional:34999@c.us',
      direction: 'OUTBOUND',
      message_type: 'TEXT',
      content: 'hola',
      is_deleted: false,
      deleted_for_me: false,
      wa_timestamp: new Date(NOW_MS),
      remote_jid: '34600@s.whatsapp.net',
      from_me: true,
      participant_jid: null,
      message_timestamp_ms: String(NOW_MS),
      ...overrides,
    },
  ];
}

interface Calls {
  patches: any[];
  sent: Array<{ jid: string; content: any; options: any }>;
  metadata: number;
}

function makeClient(
  options: BaileysClientOptions = {},
  behaviour: {
    patchError?: unknown;
    meta?: () => any;
    /** Runs inside the provider call, like Baileys' own echo. */
    duringPatch?: (client: BaileysClient, patch: any) => Promise<void>;
    duringSend?: (client: BaileysClient, sent: WAMessage) => Promise<void>;
  } = {}
): { client: BaileysClient; calls: Calls } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const calls: Calls = { patches: [], sent: [], metadata: 0 };
  const sock = {
    ev: { on: () => {} },
    user: { id: '34999:3@s.whatsapp.net', lid: '9999:3@lid' },
    appPatch: async (patch: any) => {
      if (behaviour.patchError) throw behaviour.patchError;
      calls.patches.push(patch);
      await behaviour.duringPatch?.(client, patch);
    },
    sendMessage: async (jid: string, content: any, opts: any) => {
      calls.sent.push({ jid, content, options: opts });
      const sent = {
        key: { remoteJid: jid, id: opts.messageId, fromMe: true },
        message: {
          pinInChatMessage: {
            key: content.pin,
            type: content.type,
            senderTimestampMs: NOW_MS + 5,
          },
          messageContextInfo: { messageAddOnDurationInSecs: content.time || 0 },
        },
        messageTimestamp: NOW_MS / 1000,
      } as unknown as WAMessage;
      await behaviour.duringSend?.(client, sent);
      return sent;
    },
    groupMetadata: async (jid: string) => {
      calls.metadata += 1;
      return behaviour.meta
        ? behaviour.meta()
        : { id: jid, subject: 'Grupo', restrict: false, participants: [{ id: ME_PN }] };
    },
    signalRepository: { lidMapping: { getLIDForPN: async () => null } },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean; meJid: string };
  internals.sock = sock;
  internals.ready = true;
  internals.meJid = ME_PN;
  return { client, calls };
}

function priv(client: BaileysClient): any {
  return client as any;
}

// ---------------------------------------------------------------------------
// WhatsApp shapes
// ---------------------------------------------------------------------------

test('the star patch goes to regular_high and names the author of someone else’s group message', () => {
  const own = starPatch({ remoteJid: '34600@s.whatsapp.net', id: 'M1', fromMe: true }, true);
  assert.deepEqual(own, {
    syncAction: { starAction: { starred: true } },
    index: ['star', '34600@s.whatsapp.net', 'M1', '1', '0'],
    type: 'regular_high',
    apiVersion: 2,
    operation: proto.SyncdMutation.SyncdOperation.SET,
  });
  const theirs = starPatch(
    { remoteJid: GROUP, id: 'G1', fromMe: false, participant: '2222:4@lid' },
    false
  );
  assert.deepEqual(theirs.index, ['star', GROUP, 'G1', '0', '2222@lid']);
  assert.deepEqual(theirs.syncAction, { starAction: { starred: false } });
  const ownInGroup = starPatch(
    { remoteJid: GROUP, id: 'G2', fromMe: true, participant: '34999@s.whatsapp.net' },
    true
  );
  assert.equal(ownInGroup.index[4], '0');
  const directFromContact = starPatch(
    {
      remoteJid: '34600@s.whatsapp.net',
      id: 'M2',
      fromMe: false,
      participant: '34600@s.whatsapp.net',
    },
    true
  );
  assert.deepEqual(directFromContact.index.slice(3), ['0', '0']);
});

test('request bodies: star / pin / starred list validated, pins default to 7 days', () => {
  assert.deepEqual(parseStarRequest({ messageId: ' M1 ', star: true }), {
    chatId: undefined,
    messageId: 'M1',
    star: true,
  });
  assert.equal(parseStarRequest({ chatId: 'C', messageId: 'M1', star: false }).chatId, 'C');
  for (const body of [{ star: true }, { messageId: 'M1' }, { messageId: 'M1', star: 'yes' }]) {
    assert.throws(
      () => parseStarRequest(body),
      (e: unknown) =>
        e instanceof MessageMutationError &&
        e.status === 400 &&
        e.failureClass === 'invalid_request'
    );
  }
  assert.deepEqual(parsePinRequest({ conversationId: 'C', messageId: 'M1', pin: true }), {
    chatId: 'C',
    messageId: 'M1',
    pin: true,
    durationSeconds: 604800,
  });
  assert.equal(
    parsePinRequest({ messageId: 'M1', pin: true, durationSeconds: 86400 }).durationSeconds,
    86400
  );
  assert.deepEqual(parsePinRequest({ messageId: 'M1', pin: false }), {
    chatId: undefined,
    messageId: 'M1',
    pin: false,
  });
  for (const body of [
    { messageId: 'M1', pin: true, durationSeconds: 3600 },
    { messageId: 'M1', pin: true, durationSeconds: '86400' },
    { messageId: 'M1', pin: false, durationSeconds: 86400 },
    { messageId: 'M1' },
  ]) {
    assert.throws(() => parsePinRequest(body), MessageMutationError);
  }
  assert.deepEqual(parseStarredQuery({}), { chatId: undefined, limit: 50 });
  const cursor = encodeStarredCursor({ starredAt: '2026-10-01T10:00:00.000Z', messageId: 'M9' });
  assert.deepEqual(parseStarredQuery({ conversationId: 'C', limit: 5, cursor }), {
    chatId: 'C',
    limit: 5,
    cursor: { starredAt: '2026-10-01T10:00:00.000Z', messageId: 'M9' },
  });
  for (const body of [{ limit: 0 }, { limit: 201 }, { limit: 2.5 }, { cursor: 'nope' }]) {
    assert.throws(() => parseStarredQuery(body), MessageMutationError);
  }
});

function pinMessage(
  overrides: {
    type?: number;
    duration?: number | null;
    wrap?: boolean;
    key?: Record<string, unknown>;
    target?: string;
  } = {}
): WAMessage {
  const inner: any = {
    pinInChatMessage: {
      key: {
        remoteJid: GROUP,
        id: overrides.target || 'G1',
        fromMe: false,
        participant: '2222@lid',
      },
      type: overrides.type ?? proto.Message.PinInChatMessage.Type.PIN_FOR_ALL,
      senderTimestampMs: NOW_MS,
    },
    ...(overrides.duration === null
      ? {}
      : { messageContextInfo: { messageAddOnDurationInSecs: overrides.duration ?? 86400 } }),
  };
  return {
    key: { remoteJid: GROUP, id: 'PIN1', fromMe: false, participant: '3333@lid', ...overrides.key },
    message: overrides.wrap ? { ephemeralMessage: { message: inner } } : inner,
    messageTimestamp: NOW_MS / 1000 + 1,
  } as unknown as WAMessage;
}

test('a pin action: target, time, duration; an unpin; unknown types and durations are not applied', () => {
  assert.deepEqual(pinActionOf(pinMessage()), {
    targetId: 'G1',
    chatJid: GROUP,
    pinned: true,
    at: new Date(NOW_MS),
    durationSeconds: 86400,
    actionId: 'PIN1',
  });
  assert.equal(
    pinActionOf(pinMessage({ wrap: true, duration: 2592000 }))?.durationSeconds,
    2592000
  );
  const unpin = pinActionOf(
    pinMessage({ type: proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL, duration: 0 })
  );
  assert.equal(unpin?.pinned, false);
  assert.equal(unpin?.durationSeconds, undefined);
  assert.equal(pinActionOf(pinMessage({ type: 0 })), null);
  assert.equal(pinActionOf(pinMessage({ duration: null })), null);
  assert.equal(pinActionOf(pinMessage({ duration: -5 })), null);
});

// ---------------------------------------------------------------------------
// Outbound star
// ---------------------------------------------------------------------------

test('star after a restart: key from the stored row, the patch goes out, recorded once (echo skipped)', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(sql => (isStoredSelect(sql) ? storedRow() : []));
  try {
    const { client, calls: sock } = makeClient(
      {},
      {
        // Baileys replays our own patch as messages.update {starred}.
        duringPatch: async c =>
          priv(c).handleInboundStar({
            key: { remoteJid: '34600@s.whatsapp.net', id: 'M1', fromMe: true },
            update: { starred: true },
          }),
      }
    );
    const result = await client.starMessage(undefined, 'professional:M1', true, { actor: 'dani' });
    assert.deepEqual(
      sock.patches.map(p => p.index),
      [['star', '34600@s.whatsapp.net', 'M1', '1', '0']]
    );
    const inserts = calls.filter(c => isStarInsert(c.sql));
    assert.equal(inserts.length, 1, 'the echo of our own star is not a second write');
    assert.deepEqual(inserts[0].params.slice(0, 5), [
      'professional',
      'professional:M1',
      'professional:34600@c.us',
      true,
      true,
    ]);
    assert.deepEqual(inserts[0].params.slice(6), ['connector', 'dani']);
    assert.match(inserts[0].sql, /starred IS DISTINCT FROM EXCLUDED\.starred/);
    assert.equal(result.starred, true);
    assert.equal(result.messageId, 'M1');
    assert.equal(result.conversationId, '34600@c.us');
    assert.equal(result.persisted, true);
  } finally {
    restore();
  }
});

test('star refusals: unknown message 404, group author unknown 404, WhatsApp 4xx 422; nothing recorded', async () => {
  useAccount('personal');
  let rows: Rows = [];
  const { calls, restore } = stubPool(sql => (isStoredSelect(sql) ? rows : []));
  try {
    const { client, calls: sock } = makeClient();
    await assert.rejects(
      client.starMessage('34600@c.us', 'NOPE', true),
      (e: unknown) => e instanceof MessageUnavailableError && e.status === 404
    );
    rows = storedRow({
      wa_message_id: 'G1',
      conversation_id: GROUP,
      direction: 'INBOUND',
      remote_jid: null,
      sender_wa_id: null,
    });
    await assert.rejects(
      client.starMessage(GROUP, 'G1', true),
      (e: unknown) => e instanceof MessageUnavailableError && /author/.test(String(e))
    );
    assert.equal(sock.patches.length, 0);

    rows = storedRow({ wa_message_id: 'M1', conversation_id: '34600@c.us' });
    const refusing = makeClient(
      {},
      {
        patchError: Object.assign(new Error('forbidden'), {
          isBoom: true,
          output: { statusCode: 403 },
        }),
      }
    );
    await assert.rejects(
      refusing.client.starMessage(undefined, 'M1', true),
      (e: unknown) =>
        e instanceof MessageMutationError &&
        e.status === 422 &&
        e.failureClass === 'rejected_by_whatsapp' &&
        e.code === '403'
    );
    assert.equal(calls.filter(c => isStarInsert(c.sql)).length, 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Outbound pin
// ---------------------------------------------------------------------------

test('pin in a 1:1 chat: {pin: key, type, time} with our id, recorded at its own time, echo skipped', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(sql => (isStoredSelect(sql) ? storedRow() : []));
  try {
    const { client, calls: sock } = makeClient(
      {},
      {
        duringSend: (c, sent) =>
          priv(c).ingestMessage(sent, { source: 'baileys_history_sync', publishEvent: false }),
      }
    );
    const result = await client.pinMessage(
      { messageId: 'professional:M1', pin: true, durationSeconds: 2592000 },
      { actor: 'mcp' }
    );
    assert.equal(sock.sent.length, 1);
    const [send] = sock.sent;
    assert.equal(send.jid, '34600@s.whatsapp.net');
    assert.deepEqual(send.content, {
      pin: { remoteJid: '34600@s.whatsapp.net', fromMe: true, participant: undefined, id: 'M1' },
      type: proto.PinInChat.Type.PIN_FOR_ALL,
      time: 2592000,
    });
    assert.ok(send.options.messageId, 'our own message id');
    const pins = calls.filter(c => isPinInsert(c.sql));
    assert.equal(pins.length, 1, 'the echo of our own pin is not recorded again');
    assert.deepEqual(pins[0].params, [
      'professional',
      'professional:M1',
      'professional:34600@c.us',
      true,
      new Date(NOW_MS + 5),
      new Date(NOW_MS + 5 + 2592000 * 1000),
      2592000,
      'professional:34999@c.us',
      `professional:${send.options.messageId}`,
      new Date(NOW_MS + 5),
      'connector',
      'mcp',
    ]);
    assert.match(pins[0].sql, /EXCLUDED\.action_at > whatsapp_message_pins\.action_at/);
    assert.deepEqual(result, {
      pinned: true,
      messageId: send.options.messageId,
      pinnedMessageId: 'M1',
      conversationId: '34600@c.us',
      pinnedAt: new Date(NOW_MS + 5).toISOString(),
      expiresAt: new Date(NOW_MS + 5 + 2592000 * 1000).toISOString(),
      durationSeconds: 2592000,
      persisted: true,
    });
    assert.equal(calls.filter(c => isPayloadInsert(c.sql)).length, 1, 'our pin message is kept');
  } finally {
    restore();
  }
});

test('unpin: type UNPIN_FOR_ALL, no time; an Idempotency-Key id and its claim are used', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(sql =>
    isStoredSelect(sql) ? storedRow({ wa_message_id: 'M1', conversation_id: '34600@c.us' }) : []
  );
  try {
    const { client, calls: sock } = makeClient();
    let claimed = 0;
    const result = await client.pinMessage(
      { chatId: '34600@c.us', messageId: 'M1', pin: false },
      { messageId: 'IDEMP1', beforeSend: async () => void (claimed += 1) }
    );
    assert.equal(claimed, 1);
    assert.deepEqual(sock.sent[0].content, {
      pin: { remoteJid: '34600@s.whatsapp.net', fromMe: true, participant: undefined, id: 'M1' },
      type: proto.PinInChat.Type.UNPIN_FOR_ALL,
    });
    assert.deepEqual(sock.sent[0].options, { messageId: 'IDEMP1' });
    const [pin] = calls.filter(c => isPinInsert(c.sql));
    assert.deepEqual(pin.params.slice(0, 7), [
      'personal',
      'M1',
      '34600@c.us',
      false,
      null,
      null,
      null,
    ]);
    assert.deepEqual(result, {
      pinned: false,
      messageId: 'IDEMP1',
      pinnedMessageId: 'M1',
      conversationId: '34600@c.us',
      persisted: true,
    });
  } finally {
    restore();
  }
});

test('pin in a group: members may, admins only when its info is admin-only; non-members never', async () => {
  useAccount('personal');
  const { restore } = stubPool(sql =>
    isStoredSelect(sql)
      ? storedRow({
          wa_message_id: 'G1',
          conversation_id: GROUP,
          direction: 'INBOUND',
          remote_jid: GROUP,
          from_me: false,
          participant_jid: '2222@lid',
        })
      : []
  );
  try {
    const member = makeClient();
    await member.client.pinMessage({ messageId: 'G1', pin: true, durationSeconds: 86400 });
    assert.equal(member.calls.sent[0].content.pin.participant, '2222@lid');
    assert.equal(member.calls.metadata, 1, 'fresh metadata');

    const restricted = makeClient(
      {},
      { meta: () => ({ id: GROUP, restrict: true, participants: [{ id: ME_PN, admin: null }] }) }
    );
    await assert.rejects(
      restricted.client.pinMessage({ messageId: 'G1', pin: true, durationSeconds: 86400 }),
      (e: unknown) =>
        e instanceof MessageMutationError &&
        e.status === 403 &&
        e.failureClass === 'not_group_admin'
    );
    assert.equal(restricted.calls.sent.length, 0);

    const admin = makeClient(
      {},
      { meta: () => ({ id: GROUP, restrict: true, participants: [{ id: ME_PN, admin: 'admin' }] }) }
    );
    await admin.client.pinMessage({ messageId: 'G1', pin: false });
    assert.equal(admin.calls.sent.length, 1);

    const outsider = makeClient(
      {},
      { meta: () => ({ id: GROUP, participants: [{ id: '1111@s.whatsapp.net' }] }) }
    );
    await assert.rejects(
      outsider.client.pinMessage({ messageId: 'G1', pin: true, durationSeconds: 86400 }),
      (e: unknown) => e instanceof MessageMutationError && e.failureClass === 'not_group_member'
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

test('a pin from someone in a group is recorded, no messages row; one we cannot apply only kept raw', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient();
    const result = await priv(client).ingestMessage(pinMessage({ wrap: true }), {
      source: 'live',
      publishEvent: false,
    });
    assert.deepEqual(result, { inserted: false });
    assert.equal(calls.filter(c => isMessageInsert(c.sql)).length, 0, 'a pin is not a chat row');
    const [pin] = calls.filter(c => isPinInsert(c.sql));
    assert.deepEqual(pin.params, [
      'professional',
      'professional:G1',
      'professional:120363000@g.us',
      true,
      new Date(NOW_MS),
      new Date(NOW_MS + 86400 * 1000),
      86400,
      'professional:3333@lid',
      'professional:PIN1',
      new Date(NOW_MS),
      'whatsapp',
      null,
    ]);
    assert.equal(calls.filter(c => isPayloadInsert(c.sql)).length, 1, 'the raw action is kept');

    calls.length = 0;
    await priv(client).ingestMessage(pinMessage({ duration: 45 * 24 * 3600 * 10 }), {
      source: 'live',
      publishEvent: false,
    });
    assert.equal(calls.filter(c => isPinInsert(c.sql)).length, 0);
    assert.equal(calls.filter(c => isMessageInsert(c.sql)).length, 0);
  } finally {
    restore();
  }
});

test('stars from our phone (messages.update) replace the state; a history star only fills the unknown', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient();
    await priv(client).handleInboundStar({
      key: { remoteJid: '34600@s.whatsapp.net', id: 'M7', fromMe: false },
      update: { starred: false },
    });
    await priv(client).handleInboundStar({ key: { id: 'M8' }, update: { status: 3 } });
    const [phone] = calls.filter(c => isStarInsert(c.sql));
    assert.deepEqual(phone.params.slice(0, 5), ['personal', 'M7', '34600@c.us', false, false]);
    assert.equal(phone.params[6], 'whatsapp');
    assert.match(phone.sql, /DO UPDATE SET/);
    assert.equal(calls.filter(c => isStarInsert(c.sql)).length, 1, 'no starred field, no write');

    calls.length = 0;
    const historyMessage = {
      key: { remoteJid: '34600@s.whatsapp.net', id: 'H1', fromMe: true },
      message: { conversation: 'importante' },
      messageTimestamp: NOW_MS / 1000,
      starred: true,
    } as unknown as WAMessage;
    await priv(client).ingestMessage(historyMessage, {
      source: 'baileys_history_sync',
      publishEvent: false,
    });
    const [history] = calls.filter(c => isStarInsert(c.sql));
    assert.deepEqual(history.params.slice(0, 5), ['personal', 'H1', '34600@c.us', true, true]);
    assert.equal(history.params[6], 'history');
    assert.match(history.sql, /DO NOTHING/);
  } finally {
    restore();
  }
});

test('with ingest off (pairing pool) stars and pins never touch the DB', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient({ ingest: false });
    await priv(client).handleInboundStar({
      key: { remoteJid: '34600@s.whatsapp.net', id: 'M7', fromMe: false },
      update: { starred: true },
    });
    await priv(client).ingestPinAction(pinMessage(), { source: 'live' });
    assert.deepEqual(await client.listPinnedMessages('34600@c.us'), {
      conversationId: '34600@c.us',
      pinned: [],
      persisted: false,
      limit: 3,
    });
    assert.deepEqual(await client.listStarredMessages({ limit: 10 }), {
      starred: [],
      nextCursor: null,
      persisted: false,
    });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

test('pins of a chat: canonical conversation + its external ids, active only, newest 3', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(sql => {
    if (isConversationSelect(sql))
      return [{ id: 'professional:2222@lid', external_id: '2222@lid' }];
    if (/FROM whatsapp_message_pins p/.test(sql)) {
      return [
        {
          wa_message_id: 'professional:G1',
          seen_chat_id: 'professional:34600@c.us',
          pinned_at: new Date(NOW_MS),
          expires_at: new Date(NOW_MS + 86400_000),
          duration_seconds: 86400,
          pinned_by: 'professional:2222@lid',
          source: 'whatsapp',
          conversation_id: 'professional:2222@lid',
          sender_wa_id: 'professional:2222@lid',
          direction: 'INBOUND',
          message_type: 'TEXT',
          content: 'la dirección',
          wa_timestamp: new Date(NOW_MS - 1000),
          is_deleted: false,
          chat_name: 'Ana',
        },
      ];
    }
    return [];
  });
  try {
    const { client } = makeClient();
    const list = await client.listPinnedMessages('professional:34600@c.us');
    const query = calls.find(c => /FROM whatsapp_message_pins p/.test(c.sql))!;
    assert.deepEqual(query.params.slice(0, 2), [
      'professional',
      ['professional:2222@lid', 'professional:34600@c.us', 'professional:34600@s.whatsapp.net'],
    ]);
    assert.match(query.sql, /p\.pinned AND p\.expires_at > \$3/);
    assert.match(query.sql, /LIMIT 3/);
    assert.deepEqual(list, {
      conversationId: '2222@lid',
      pinned: [
        {
          messageId: 'G1',
          conversationId: '2222@lid',
          chatName: 'Ana',
          senderId: '2222@lid',
          direction: 'INBOUND',
          messageType: 'TEXT',
          content: 'la dirección',
          sentAt: new Date(NOW_MS - 1000).toISOString(),
          isDeleted: false,
          pinnedAt: new Date(NOW_MS).toISOString(),
          expiresAt: new Date(NOW_MS + 86400_000).toISOString(),
          durationSeconds: 86400,
          pinnedBy: '2222@lid',
          source: 'whatsapp',
        },
      ],
      persisted: true,
      limit: 3,
    });
  } finally {
    restore();
  }
});

test('starred list: account-wide or one chat, keyset cursor; tables missing = empty, persisted false', async () => {
  useAccount('personal');
  const row = (id: string, ms: number) => ({
    wa_message_id: id,
    seen_chat_id: '34600@c.us',
    starred_at: new Date(ms),
    source: 'whatsapp',
    conversation_id: null,
    sender_wa_id: null,
    direction: null,
    message_type: null,
    content: null,
    wa_timestamp: null,
    is_deleted: false,
    chat_name: null,
  });
  let missing = false;
  const { calls, restore } = stubPool(sql => {
    if (missing) return missingTable('whatsapp_message_stars');
    if (/FROM whatsapp_message_stars s/.test(sql))
      return [row('S3', NOW_MS), row('S2', NOW_MS - 1)];
    return [];
  });
  try {
    const { client } = makeClient();
    const page = await client.listStarredMessages({ limit: 1 });
    const query = calls.find(c => /FROM whatsapp_message_stars s/.test(c.sql))!;
    assert.deepEqual(query.params, ['personal', 2]);
    assert.doesNotMatch(query.sql, /ANY\(/);
    assert.equal(page.starred.length, 1);
    assert.equal(page.starred[0].messageId, 'S3');
    assert.equal(page.starred[0].conversationId, '34600@c.us', 'the seen chat when never ingested');
    assert.ok(page.nextCursor);

    calls.length = 0;
    const next = await client.listStarredMessages({
      chatId: '34600@c.us',
      limit: 10,
      cursor: parseStarredQuery({ cursor: page.nextCursor }).cursor,
    });
    const chatQuery = calls.find(c => /FROM whatsapp_message_stars s/.test(c.sql))!;
    assert.deepEqual(chatQuery.params, [
      'personal',
      ['34600@c.us', '34600@s.whatsapp.net'],
      new Date(NOW_MS).toISOString(),
      'S3',
      11,
    ]);
    assert.match(
      chatQuery.sql,
      /\(s\.starred_at, s\.wa_message_id\) < \(\$3::timestamptz, \$4::text\)/
    );
    assert.equal(next.conversationId, '34600@c.us');
    assert.equal(next.nextCursor, null);

    missing = true;
    assert.deepEqual(await client.listStarredMessages({ limit: 10 }), {
      starred: [],
      nextCursor: null,
      persisted: false,
    });
    calls.length = 0;
    const star = await priv(client).handleInboundStar({
      key: { remoteJid: '34600@s.whatsapp.net', id: 'M7' },
      update: { starred: true },
    });
    assert.equal(star, undefined);
    assert.equal(calls.length, 0, 'known missing: not re-probed before its time');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

async function withRouter(
  client: Partial<BaileysClient>,
  env: Record<string, string | undefined>,
  run: (call: Call) => Promise<void>
): Promise<void> {
  const secret = 'test-secret';
  const app = express();
  app.use(express.json());
  const qr = { getCurrentQR: () => null, clearQR: () => {} };
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

function recordingClient(connected = true): { client: Partial<BaileysClient>; seen: unknown[] } {
  const seen: unknown[] = [];
  const client = {
    isConnected: () => connected,
    getCachedState: () => (connected ? 'CONNECTED' : 'DISCONNECTED'),
    isIngestEnabled: () => true,
    starMessage: async (chatId: any, messageId: string, star: boolean, request: any) => {
      seen.push(['star', chatId, messageId, star, request?.actor]);
      return {
        starred: star,
        messageId,
        conversationId: '34600@c.us',
        starredAt: 'T',
        persisted: true,
      };
    },
    pinMessage: async (request: any, options: any) => {
      seen.push(['pin', request, options?.actor]);
      return {
        pinned: request.pin,
        messageId: 'PIN9',
        pinnedMessageId: request.messageId,
        conversationId: '34600@c.us',
        persisted: true,
      };
    },
    listPinnedMessages: async (chatId: string) => {
      seen.push(['pins', chatId]);
      return { conversationId: chatId, pinned: [], limit: 3, persisted: true };
    },
    listStarredMessages: async (query: any) => {
      seen.push(['starred', query]);
      return { starred: [], nextCursor: null, persisted: true };
    },
  };
  return { client: client as Partial<BaileysClient>, seen };
}

const SENDING_ON = { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined };

test('HTTP: star / pin are gated (403) after validation; the lists are not', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, { ENABLE_SENDING: undefined }, async call => {
    for (const [path, body] of [
      ['/messages/star', { messageId: 'M1', star: true }],
      ['/messages/pin', { messageId: 'M1', pin: true }],
    ] as const) {
      const res = await call('POST', path, body);
      assert.equal(res.status, 403);
      assert.equal((await res.json()).failureClass, 'disabled_sending');
    }
    const invalid = await call('POST', '/messages/star', { messageId: 'M1' });
    assert.equal(invalid.status, 400, 'validated before the gate');
    assert.equal((await call('POST', '/messages/pins', { conversationId: 'C' })).status, 200);
    assert.equal((await call('POST', '/messages/starred', {})).status, 200);
  });
  await withRouter(
    client,
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' },
    async call => {
      const res = await call('POST', '/messages/pin', { messageId: 'M1', pin: false });
      assert.equal(res.status, 403);
    }
  );
  assert.deepEqual(seen, [
    ['pins', 'C'],
    ['starred', { chatId: undefined, limit: 50 }],
  ]);
});

test('HTTP: 200 shapes with ids from the signed body; 400s; 503 disconnected; errors mapped', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, SENDING_ON, async call => {
    const star = await call('POST', '/messages/star', {
      conversationId: '34600@c.us',
      messageId: 'M1',
      star: false,
      actor: 'dani',
    });
    assert.equal(star.status, 200);
    assert.deepEqual(await star.json(), {
      starred: false,
      messageId: 'M1',
      conversationId: '34600@c.us',
      starredAt: 'T',
      persisted: true,
    });
    const pin = await call('POST', '/messages/pin', {
      messageId: 'M1',
      pin: true,
      durationSeconds: 86400,
      actor: 'mcp',
    });
    assert.equal(pin.status, 200);
    assert.equal((await pin.json()).messageId, 'PIN9');
    const starred = await call('POST', '/messages/starred', { conversationId: 'C', limit: 5 });
    assert.equal(starred.status, 200);
    for (const [path, body] of [
      ['/messages/pin', { messageId: 'M1', pin: true, durationSeconds: 60 }],
      ['/messages/pin', { messageId: 'M1', pin: false, durationSeconds: 86400 }],
      ['/messages/pins', {}],
      ['/messages/starred', { limit: 1000 }],
      ['/messages/starred', { cursor: 'x' }],
    ] as const) {
      const res = await call('POST', path, body);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.equal((await res.json()).failureClass, 'invalid_request');
    }
  });
  assert.deepEqual(seen, [
    ['star', '34600@c.us', 'M1', false, 'dani'],
    ['pin', { chatId: undefined, messageId: 'M1', pin: true, durationSeconds: 86400 }, 'mcp'],
    ['starred', { chatId: 'C', limit: 5 }],
  ]);

  await withRouter(recordingClient(false).client, SENDING_ON, async call => {
    const res = await call('POST', '/messages/star', { messageId: 'M1', star: true });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).failureClass, 'disconnected');
    assert.equal((await call('POST', '/messages/pin', { messageId: 'M1', pin: true })).status, 503);
    assert.equal((await call('POST', '/messages/pins', { conversationId: 'C' })).status, 200);
  });

  const failing = {
    ...recordingClient().client,
    starMessage: async () => {
      throw new MessageUnavailableError('unknown', 404, 'message_unavailable');
    },
    pinMessage: async () => {
      throw new MessageMutationError('Only admins can pin', 403, 'not_group_admin');
    },
  };
  await withRouter(failing, SENDING_ON, async call => {
    const star = await call('POST', '/messages/star', { messageId: 'M1', star: true });
    assert.equal(star.status, 404);
    assert.equal((await star.json()).failureClass, 'message_unavailable');
    const pin = await call('POST', '/messages/pin', { messageId: 'M1', pin: true });
    assert.equal(pin.status, 403);
    assert.equal((await pin.json()).failureClass, 'not_group_admin');
  });
});

test('star is disabled unless WA_STAR_ENABLED=true: refused before touching WhatsApp', async () => {
  const previous = process.env.WA_STAR_ENABLED;
  delete process.env.WA_STAR_ENABLED;
  try {
    let socketTouched = false;
    const fake = {
      connectedSocket: () => {
        socketTouched = true;
        throw new Error('socket must not be used');
      },
    };
    await assert.rejects(
      () => BaileysClient.prototype.starMessage.call(fake as unknown as BaileysClient, '34600@s.whatsapp.net', 'ABC', true),
      (e: unknown) => e instanceof MessageMutationError && e.status === 403 && e.failureClass === 'star_disabled'
    );
    assert.equal(socketTouched, false);
  } finally {
    if (previous === undefined) delete process.env.WA_STAR_ENABLED;
    else process.env.WA_STAR_ENABLED = previous;
  }
});
