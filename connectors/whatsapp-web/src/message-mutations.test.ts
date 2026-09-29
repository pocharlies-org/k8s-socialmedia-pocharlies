/**
 * Edit / delete of WhatsApp messages (fase 3 / PR-3): the BaileysClient paths
 * (outbound edit, revoke, delete-for-me; inbound edits, revokes and synced
 * deletes-for-me) and the HTTP routes that expose them.
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test (same harness as durable-paths.test.ts).
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
import { proto } from '@whiskeysockets/baileys';
import { BaileysClient, BaileysClientOptions } from './baileys-client';
import {
  MessageUnavailableError,
  resetDurableStoreStateForTests,
  serializeDurableValue,
  toDurablePayload,
} from './durable-message-store';
import { MessageMutationError } from './message-mutations';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

process.env.WA_SEND_ERROR_ACK_WAIT_MS = '0';

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
    return Promise.resolve({ rows: route(sql, params) });
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
}

const isStoredSelect = (sql: string): boolean =>
  /FROM messages m\s+LEFT JOIN whatsapp_message_keys/i.test(sql);
const isPayloadSelect = (sql: string): boolean =>
  /FROM whatsapp_message_payloads/i.test(sql) && /SELECT/i.test(sql);
const updates = (calls: QueryCall[]): QueryCall[] =>
  calls.filter(c => /^\s*UPDATE messages/i.test(c.sql));

/** A messages row (+ its whatsapp_message_keys columns) as the join returns it. */
function storedRow(overrides: Record<string, unknown> = {}): Rows {
  return [
    {
      wa_message_id: 'M1',
      conversation_id: '34600@c.us',
      sender_wa_id: '34999@c.us',
      direction: 'OUTBOUND',
      message_type: 'TEXT',
      content: 'hola',
      is_deleted: false,
      deleted_for_me: false,
      wa_timestamp: new Date(1_700_000_000_000),
      remote_jid: '34600@s.whatsapp.net',
      from_me: true,
      participant_jid: null,
      message_timestamp_ms: '1700000000000',
      ...overrides,
    },
  ];
}

interface SockCalls {
  sent: Array<{ jid: string; content: any }>;
  modified: Array<{ mod: any; jid: string }>;
}

function makeClient(
  options: BaileysClientOptions = {},
  behaviour: { rejectChatModify?: boolean } = {}
): { client: BaileysClient; calls: SockCalls; events: any[] } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const calls: SockCalls = { sent: [], modified: [] };
  let n = 0;
  const sock = {
    sendMessage: async (jid: string, content: any) => {
      calls.sent.push({ jid, content });
      n += 1;
      return { key: { remoteJid: jid, id: `STANZA${n}`, fromMe: true }, message: {} };
    },
    chatModify: async (mod: any, jid: string) => {
      calls.modified.push({ mod, jid });
      if (behaviour.rejectChatModify) throw new Error('provider rejected');
    },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean };
  internals.sock = sock;
  internals.ready = true;
  const events: any[] = [];
  client.on('message-update', e => events.push(e));
  return { client, calls, events };
}

function priv(client: BaileysClient): any {
  return client as any;
}

// ---------------------------------------------------------------------------
// Outbound edit
// ---------------------------------------------------------------------------

test('edit of our text message sends { text, edit: key } and keeps the old text in edit_history', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(sql =>
    isStoredSelect(sql) ? storedRow({ wa_message_id: 'professional:M1' }) : []
  );
  try {
    const { client, calls: sock, events } = makeClient();
    const result = await client.editMessage('34600@c.us', 'professional:M1', 'hola, editado', {
      actor: 'dani',
    });

    const select = calls.find(c => isStoredSelect(c.sql))!;
    assert.deepEqual(select.params, ['professional:M1', 'whatsapp:professional']);
    assert.equal(sock.sent.length, 1);
    assert.equal(sock.sent[0].jid, '34600@s.whatsapp.net');
    assert.equal(sock.sent[0].content.text, 'hola, editado');
    assert.deepEqual(sock.sent[0].content.edit, {
      remoteJid: '34600@s.whatsapp.net',
      fromMe: true,
      participant: undefined,
      id: 'M1',
    });

    const [update] = updates(calls);
    assert.match(update.sql, /is_edited = TRUE/);
    assert.match(update.sql, /'edit_history'/);
    assert.match(update.sql, /'content', content/, 'the replaced (old) text goes to history');
    assert.match(update.sql, /content IS DISTINCT FROM \$3/, 'a replay changes nothing');
    assert.equal(update.params[0], 'professional:M1');
    assert.equal(update.params[1], 'whatsapp:professional');
    assert.equal(update.params[2], 'hola, editado');
    assert.equal(update.params[4], 'connector');
    assert.equal(update.params[5], 'dani');

    assert.equal(result.messageId, 'M1');
    assert.equal(result.editId, 'STANZA1');
    assert.deepEqual(events, [
      { waMessageId: 'M1', updateType: 'EDITED', newContent: 'hola, editado' },
    ]);
  } finally {
    restore();
  }
});

test('edit refuses someone else’s message, a non-text message and a deleted one (nothing sent)', async () => {
  useAccount('personal');
  for (const [row, failureClass] of [
    [{ direction: 'INBOUND', from_me: false }, 'not_own_message'],
    [{ message_type: 'IMAGE' }, 'not_editable'],
    [{ is_deleted: true }, 'not_editable'],
  ] as const) {
    const { calls, restore } = stubPool(sql => (isStoredSelect(sql) ? storedRow(row) : []));
    try {
      const { client, calls: sock } = makeClient();
      await assert.rejects(
        client.editMessage('34600@c.us', 'M1', 'nuevo'),
        (e: unknown) =>
          e instanceof MessageMutationError && e.status === 422 && e.failureClass === failureClass
      );
      assert.equal(sock.sent.length, 0);
      assert.equal(updates(calls).length, 0);
    } finally {
      restore();
    }
  }
});

test('an edit WhatsApp rejects (error ack) surfaces as 422 rejected_by_whatsapp and writes nothing', async () => {
  useAccount('personal');
  process.env.WA_SEND_ERROR_ACK_WAIT_MS = '200';
  const { calls, restore } = stubPool(sql => (isStoredSelect(sql) ? storedRow() : []));
  try {
    const { client, events } = makeClient();
    const pending = client.editMessage('34600@c.us', 'M1', 'tarde');
    // The ack error for the edit stanza, as the messages.update handler reports it.
    setTimeout(
      () =>
        priv(client).resolveImmediateSendFailure('STANZA1', {
          failureClass: 'unknown',
          code: '479',
          message: 'rejected',
        }),
      20
    );
    await assert.rejects(
      pending,
      (e: unknown) =>
        e instanceof MessageMutationError &&
        e.status === 422 &&
        e.failureClass === 'rejected_by_whatsapp' &&
        e.code === '479'
    );
    assert.equal(updates(calls).length, 0);
    assert.equal(events.length, 0);
  } finally {
    process.env.WA_SEND_ERROR_ACK_WAIT_MS = '0';
    restore();
  }
});

// ---------------------------------------------------------------------------
// Delete for everyone (revoke)
// ---------------------------------------------------------------------------

test('delete for everyone revokes with the stored key and flags the row, keeping its content', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(sql => (isStoredSelect(sql) ? storedRow() : []));
  try {
    const { client, calls: sock, events } = makeClient();
    const result = await client.deleteMessage('34600@c.us', 'M1', { actor: 'dani' });

    assert.deepEqual(sock.sent[0].content.delete, {
      remoteJid: '34600@s.whatsapp.net',
      fromMe: true,
      participant: undefined,
      id: 'M1',
    });
    const [update] = updates(calls);
    assert.match(update.sql, /is_deleted = TRUE/);
    assert.match(update.sql, /status = 'deleted'/);
    assert.doesNotMatch(update.sql, /SET[\s\S]*\bcontent\s*=/, 'content is never overwritten');
    assert.deepEqual(update.params.slice(0, 2), ['M1', 'whatsapp:personal']);
    assert.equal(result.messageId, 'M1');
    assert.deepEqual(events, [{ waMessageId: 'M1', updateType: 'DELETED' }]);
  } finally {
    restore();
  }
});

test('delete for everyone of a contact’s 1:1 message is refused; in a group it goes out as admin revoke', async () => {
  useAccount('personal');
  {
    const { restore } = stubPool(sql =>
      isStoredSelect(sql) ? storedRow({ direction: 'INBOUND', from_me: false }) : []
    );
    try {
      const { client, calls: sock } = makeClient();
      await assert.rejects(
        client.deleteMessage('34600@c.us', 'M1'),
        (e: unknown) => e instanceof MessageMutationError && e.failureClass === 'not_own_message'
      );
      assert.equal(sock.sent.length, 0);
    } finally {
      restore();
    }
  }
  {
    const { restore } = stubPool(sql =>
      isStoredSelect(sql)
        ? storedRow({
            conversation_id: '120363@g.us',
            direction: 'INBOUND',
            remote_jid: '120363@g.us',
            from_me: false,
            participant_jid: '34611@s.whatsapp.net',
          })
        : []
    );
    try {
      const { client, calls: sock } = makeClient();
      await client.deleteMessage('120363@g.us', 'M1');
      assert.deepEqual(sock.sent[0].content.delete, {
        remoteJid: '120363@g.us',
        fromMe: false,
        participant: '34611@s.whatsapp.net',
        id: 'M1',
      });
    } finally {
      restore();
    }
  }
});

// ---------------------------------------------------------------------------
// Delete for me
// ---------------------------------------------------------------------------

test('delete for me after a restart uses the durable key + timestamp and only persists after the provider ack', async () => {
  useAccount('professional');
  // No memory at all: the key comes from whatsapp_message_keys.
  const { calls, restore } = stubPool(sql =>
    isStoredSelect(sql)
      ? storedRow({
          wa_message_id: 'professional:M1',
          direction: 'INBOUND',
          from_me: false,
          remote_jid: '34600@lid',
        })
      : []
  );
  try {
    const failing = makeClient({}, { rejectChatModify: true });
    await assert.rejects(
      failing.client.deleteMessageForMe('34600@c.us', 'M1'),
      /provider rejected/
    );
    assert.equal(updates(calls).length, 0, 'nothing written when WhatsApp refuses');

    const { client, calls: sock, events } = makeClient();
    await client.deleteMessageForMe('professional:34600@c.us', 'professional:M1');
    assert.deepEqual(sock.modified[0], {
      mod: {
        deleteForMe: {
          deleteMedia: false,
          key: { remoteJid: '34600@lid', fromMe: false, participant: undefined, id: 'M1' },
          timestamp: 1_700_000_000,
        },
      },
      jid: '34600@lid',
    });
    const [update] = updates(calls);
    assert.match(update.sql, /'deleted_for_me', TRUE/);
    assert.doesNotMatch(update.sql, /is_deleted/, 'delete for me never touches is_deleted');
    assert.deepEqual(update.params.slice(0, 2), ['professional:M1', 'whatsapp:professional']);
    assert.equal(events.length, 0, 'delete for me is not published on the bus');
  } finally {
    restore();
  }
});

test('delete for me prefers the durable payload timestamp and key', async () => {
  useAccount('personal');
  const { restore } = stubPool(sql => {
    if (isStoredSelect(sql)) return storedRow({ remote_jid: null });
    if (isPayloadSelect(sql))
      return [
        {
          message_key: JSON.parse(
            serializeDurableValue({ remoteJid: '34600@s.whatsapp.net', id: 'M1', fromMe: true })
          ),
          message_payload: JSON.parse(serializeDurableValue(toDurablePayload({ conversation: 'x' }))),
          wa_timestamp: new Date(1_700_000_123_000),
          push_name: null,
        },
      ];
    return [];
  });
  try {
    const { client, calls: sock } = makeClient();
    await client.deleteMessageForMe('34600@c.us', 'M1');
    assert.equal(sock.modified[0].mod.deleteForMe.timestamp, 1_700_000_123);
    assert.equal(sock.modified[0].mod.deleteForMe.key.id, 'M1');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Unknown message, ingest off
// ---------------------------------------------------------------------------

test('edit / delete / delete-for-me of an unknown message are a 404 message_unavailable and send nothing', async () => {
  useAccount('personal');
  const { restore } = stubPool();
  try {
    const { client, calls: sock } = makeClient();
    for (const run of [
      () => client.editMessage('34600@c.us', 'NOPE', 'x'),
      () => client.deleteMessage('34600@c.us', 'NOPE'),
      () => client.deleteMessageForMe('34600@c.us', 'NOPE'),
    ]) {
      await assert.rejects(
        run(),
        (e: unknown) =>
          e instanceof MessageUnavailableError &&
          e.status === 404 &&
          e.failureClass === 'message_unavailable'
      );
    }
    assert.equal(sock.sent.length + sock.modified.length, 0);
  } finally {
    restore();
  }
});

test('with ingest off nothing is read or written, even when the action goes out from memory', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(sql => (isStoredSelect(sql) ? storedRow() : []));
  try {
    const { client, calls: sock } = makeClient({ ingest: false });
    const key = { remoteJid: '34600@s.whatsapp.net', id: 'MEM', fromMe: true };
    priv(client).rememberKey('MEM', key, key.remoteJid);
    priv(client).rememberMessageForRetry(key, { conversation: 'en memoria' });

    await client.editMessage('34600@c.us', 'MEM', 'editado');
    await client.deleteMessage('34600@c.us', 'MEM');
    await assert.rejects(client.editMessage('34600@c.us', 'M1', 'x'), MessageUnavailableError);
    await priv(client).handleInboundMutation({
      key: { remoteJid: '34600@s.whatsapp.net', id: 'M1', fromMe: false },
      update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE },
    });
    assert.equal(sock.sent.length, 2);
    assert.equal(calls.length, 0, 'the pairing pool never touches the DB');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Inbound (contact / our phone)
// ---------------------------------------------------------------------------

test('an inbound edit replaces the text, keeps the old one in edit_history and publishes EDITED', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool();
  try {
    const { client, events } = makeClient();
    await priv(client).handleInboundMutation({
      key: { remoteJid: '34600@s.whatsapp.net', id: 'IN1', fromMe: false },
      update: {
        message: { editedMessage: { message: { conversation: 'texto corregido' } } },
        messageTimestamp: 1_700_000_500,
      },
    });
    const [update] = updates(calls);
    assert.match(update.sql, /'edit_history'/);
    assert.match(update.sql, /COALESCE\(metadata->'edit_history', '\[\]'::jsonb\) \|\|/);
    assert.deepEqual(update.params.slice(0, 3), [
      'professional:IN1',
      'whatsapp:professional',
      'texto corregido',
    ]);
    assert.equal(update.params[4], 'whatsapp');
    assert.deepEqual(events, [
      { waMessageId: 'IN1', updateType: 'EDITED', newContent: 'texto corregido' },
    ]);
  } finally {
    restore();
  }
});

test('an inbound revoke flags the row (content kept) and publishes DELETED once', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client, events } = makeClient();
    await priv(client).handleInboundMutation({
      key: { remoteJid: '34600@s.whatsapp.net', id: 'IN2', fromMe: false },
      update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE },
    });
    const all = updates(calls);
    assert.equal(all.length, 1, 'one write (no separate status update)');
    assert.match(all[0].sql, /is_deleted = TRUE/);
    assert.doesNotMatch(all[0].sql, /SET[\s\S]*\bcontent\s*=/);
    assert.equal(all[0].params[3], 'whatsapp');
    assert.deepEqual(events, [{ waMessageId: 'IN2', updateType: 'DELETED' }]);
  } finally {
    restore();
  }
});

test('the echo of our own edit/revoke is left to the explicit call (no second write or event)', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(sql => (isStoredSelect(sql) ? storedRow() : []));
  try {
    const { client, events } = makeClient();
    await client.editMessage('34600@c.us', 'M1', 'otra vez');
    await client.deleteMessage('34600@c.us', 'M1');
    // What Baileys emits back for our own protocol messages.
    await priv(client).handleInboundMutation({
      key: { remoteJid: '34600@s.whatsapp.net', id: 'M1', fromMe: true },
      update: { message: { editedMessage: { message: { conversation: 'otra vez' } } } },
    });
    await priv(client).handleInboundMutation({
      key: { remoteJid: '34600@s.whatsapp.net', id: 'M1', fromMe: true },
      update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE },
    });
    assert.equal(updates(calls).length, 2, 'one write per explicit call');
    assert.deepEqual(
      events.map(e => e.updateType),
      ['EDITED', 'DELETED']
    );
  } finally {
    restore();
  }
});

test('a delete-for-me synced from our phone sets the flag; a whole-chat clear is ignored', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool();
  try {
    const { client, events } = makeClient();
    await priv(client).handleDeleteForMeSync({
      keys: [{ remoteJid: '34600@s.whatsapp.net', id: 'P1', fromMe: false }],
    });
    await priv(client).handleDeleteForMeSync({ jid: '34600@s.whatsapp.net', all: true });
    const all = updates(calls);
    assert.equal(all.length, 1);
    assert.match(all[0].sql, /'deleted_for_me', TRUE/);
    assert.deepEqual(all[0].params.slice(0, 2), ['professional:P1', 'whatsapp:professional']);
    assert.equal(events.length, 0);
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

function recordingClient(): { client: Partial<BaileysClient>; seen: string[] } {
  const seen: string[] = [];
  const client = {
    isConnected: () => true,
    getCachedState: () => 'CONNECTED',
    editMessage: async (_c: string, id: string, content: string, request?: { actor?: string }) => {
      seen.push(`edit:${id}:${content}:${request?.actor ?? ''}`);
      return { messageId: id, editId: 'STANZA', editedAt: '2026-09-29T10:00:00.000Z' };
    },
    deleteMessage: async (_c: string, id: string) => {
      seen.push(`revoke:${id}`);
      return { messageId: id, deletedAt: '2026-09-29T10:00:00.000Z' };
    },
    deleteMessageForMe: async (_c: string, id: string) => {
      seen.push(`forme:${id}`);
      return { messageId: id, deletedAt: '2026-09-29T10:00:00.000Z' };
    },
    forwardMessage: async () => {
      seen.push('forward');
      return 'NEW';
    },
  };
  return { client: client as unknown as Partial<BaileysClient>, seen };
}

const EDIT = { chatId: '34600@c.us', messageId: 'M1', content: 'nuevo' };
const DEL = { chatId: '34600@c.us', messageId: 'M1' };

test('HTTP: with ENABLE_SENDING off, edit / delete / delete-for-me are 403 and never reach WhatsApp', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined }, async call => {
    for (const res of [
      await call('POST', '/messages/edit', EDIT),
      await call('POST', '/messages/delete', DEL),
      await call('POST', '/messages/delete', { ...DEL, forMe: true }),
      await call('DELETE', '/messages/34600%40c.us/M1'),
    ]) {
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'disabled_sending');
    }
  });
  assert.deepEqual(seen, []);
});

test('HTTP: the emergency sending lock blocks forward and every delete before any provider call', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' }, async call => {
    const forward = await call('POST', '/messages/forward', {
      chatId: '34600@c.us',
      messageId: 'M1',
      toChatId: '34611@c.us',
    });
    assert.equal(forward.status, 403);
    assert.equal((await call('POST', '/messages/edit', EDIT)).status, 403);
    assert.equal((await call('POST', '/messages/delete', DEL)).status, 403);
    assert.equal((await call('POST', '/messages/delete', { ...DEL, forMe: true })).status, 403);
    assert.equal((await call('DELETE', '/messages/34600%40c.us/M1')).status, 403);
  });
  assert.deepEqual(seen, []);
});

test('HTTP: 200 shapes of edit, delete for everyone, delete for me and the legacy DELETE', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined }, async call => {
    const edit = await call('POST', '/messages/edit', { ...EDIT, actor: '  dani  ' });
    assert.equal(edit.status, 200);
    assert.deepEqual(await edit.json(), {
      edited: true,
      messageId: 'M1',
      editId: 'STANZA',
      editedAt: '2026-09-29T10:00:00.000Z',
    });
    const everyone = await call('POST', '/messages/delete', DEL);
    assert.deepEqual(await everyone.json(), {
      deleted: true,
      scope: 'everyone',
      messageId: 'M1',
      deletedAt: '2026-09-29T10:00:00.000Z',
    });
    const me = await call('POST', '/messages/delete', { ...DEL, forMe: true });
    assert.equal(((await me.json()) as { scope: string }).scope, 'me');
    const legacy = await call('DELETE', '/messages/34600%40c.us/M1');
    assert.equal(((await legacy.json()) as { deleted: boolean }).deleted, true);
  });
  assert.deepEqual(seen, ['edit:M1:nuevo:dani', 'revoke:M1', 'forme:M1', 'revoke:M1']);
});

test('HTTP: 400 on missing fields, 503 when disconnected, 404 / 422 mapped with failureClass', async () => {
  const { client, seen } = recordingClient();
  let failure: Error = new MessageUnavailableError('gone', 404, 'message_unavailable');
  let connected = true;
  Object.assign(client, {
    isConnected: () => connected,
    editMessage: async () => {
      throw failure;
    },
  });
  await withRouter(client, { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined }, async call => {
    assert.equal((await call('POST', '/messages/edit', { ...EDIT, content: '  ' })).status, 400);
    assert.equal((await call('POST', '/messages/delete', { chatId: 'x' })).status, 400);
    assert.equal((await call('POST', '/messages/delete', { ...DEL, forMe: 'yes' })).status, 400);

    const missing = await call('POST', '/messages/edit', EDIT);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { failureClass: string }).failureClass, 'message_unavailable');

    failure = new MessageMutationError('late', 422, 'rejected_by_whatsapp', '479');
    const rejected = await call('POST', '/messages/edit', EDIT);
    assert.equal(rejected.status, 422);
    assert.deepEqual(await rejected.json(), {
      error: 'late',
      failureClass: 'rejected_by_whatsapp',
      code: '479',
    });

    connected = false;
    const offline = await call('POST', '/messages/delete', DEL);
    assert.equal(offline.status, 503);
    assert.equal(((await offline.json()) as { failureClass: string }).failureClass, 'disconnected');
  });
  assert.deepEqual(seen, []);
});
