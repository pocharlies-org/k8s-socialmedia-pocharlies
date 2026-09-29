/**
 * WhatsApp reactions (fase 3 / PR-4): the whatsapp_message_reactions writes
 * (inbound, from our phone, sent by us), the reactToMessage path (gate, key
 * after a restart, no silent success) and the HTTP route.
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test (same harness as message-mutations.test.ts).
 * The DB side (PN/LID collapse, removal, ordering, merge/unmerge) is exercised
 * against a real Postgres when migration 011 is validated.
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
import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysClient, BaileysClientOptions } from './baileys-client';
import {
  MessageUnavailableError,
  resetDurableStoreStateForTests,
  serializeDurableValue,
  toDurablePayload,
} from './durable-message-store';
import {
  reactionTime,
  resetReactionStoreStateForTests,
  storeMessageReaction,
} from './message-reactions';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

interface QueryCall {
  sql: string;
  params: unknown[];
}

type Rows = Record<string, unknown>[];

/** route may return rows or an Error (the query rejects with it). */
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
    return out instanceof Error ? Promise.reject(out) : Promise.resolve({ rows: out });
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
  resetReactionStoreStateForTests();
}

const isReactionInsert = (sql: string): boolean =>
  /INSERT INTO whatsapp_message_reactions/i.test(sql);
const reactionInserts = (calls: QueryCall[]): QueryCall[] =>
  calls.filter(c => isReactionInsert(c.sql));
const isStoredSelect = (sql: string): boolean =>
  /FROM messages m\s+LEFT JOIN whatsapp_message_keys/i.test(sql);
const isPayloadSelect = (sql: string): boolean =>
  /FROM whatsapp_message_payloads/i.test(sql) && /SELECT/i.test(sql);

function missingTable(): Error {
  return Object.assign(new Error('relation "whatsapp_message_reactions" does not exist'), {
    code: '42P01',
  });
}

const SENT_REACTION_MS = 1_790_000_000_123;

function makeClient(options: BaileysClientOptions = {}): {
  client: BaileysClient;
  sent: Array<{ jid: string; content: any }>;
} {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const sent: Array<{ jid: string; content: any }> = [];
  let n = 0;
  const sock = {
    sendMessage: async (jid: string, content: any) => {
      sent.push({ jid, content });
      n += 1;
      return {
        key: { remoteJid: jid, id: `REACT${n}`, fromMe: true },
        message: content.react
          ? { reactionMessage: { ...content.react, senderTimestampMs: SENT_REACTION_MS } }
          : {},
      };
    },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean; meJid: string };
  internals.sock = sock;
  internals.ready = true;
  internals.meJid = '34999@s.whatsapp.net';
  return { client, sent };
}

function priv(client: BaileysClient): any {
  return client as any;
}

/** A messages row (+ its whatsapp_message_keys columns) as the join returns it. */
function storedRow(overrides: Record<string, unknown> = {}): Rows {
  return [
    {
      wa_message_id: 'M1',
      conversation_id: '34600@lid',
      sender_wa_id: '34600@lid',
      direction: 'INBOUND',
      message_type: 'TEXT',
      content: 'hola',
      is_deleted: false,
      deleted_for_me: false,
      wa_timestamp: new Date(1_700_000_000_000),
      remote_jid: '34600@lid',
      from_me: false,
      participant_jid: null,
      message_timestamp_ms: '1700000000000',
      ...overrides,
    },
  ];
}

function reaction(opts: {
  id: string;
  target: string;
  emoji: string;
  fromMe?: boolean | null;
  remoteJid?: string;
  participant?: string;
  senderTimestampMs?: number;
}): WAMessage {
  const remoteJid = opts.remoteJid || '34600@s.whatsapp.net';
  const ms = opts.senderTimestampMs ?? 1_790_000_000_000;
  return {
    key: {
      remoteJid,
      id: opts.id,
      fromMe: opts.fromMe as boolean,
      ...(opts.participant ? { participant: opts.participant } : {}),
    },
    message: {
      reactionMessage: {
        key: { remoteJid, id: opts.target, fromMe: !opts.fromMe },
        text: opts.emoji,
        senderTimestampMs: ms,
      },
    },
    messageTimestamp: Math.floor(ms / 1000),
    pushName: 'Ada',
  } as WAMessage;
}

// ---------------------------------------------------------------------------
// storeMessageReaction (ported from the NAS fork)
// ---------------------------------------------------------------------------

test('reactions use an account-scoped target and explicit removal state', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool();
  try {
    await storeMessageReaction({
      targetMessageId: 'target',
      conversationId: '34600@c.us',
      reactorJid: '34600@c.us',
      reactionMessageId: 'reaction',
      emoji: '👍',
    });
    await storeMessageReaction({
      targetMessageId: 'target',
      conversationId: '34600@c.us',
      reactorJid: '34600@c.us',
      emoji: '',
    });
    assert.equal(calls[0].params[0], 'professional');
    assert.equal(calls[0].params[1], 'professional:target');
    assert.equal(calls[0].params[2], 'professional:34600@c.us');
    assert.equal(calls[0].params[3], 'professional:34600@c.us');
    assert.equal(calls[0].params[4], 'professional:reaction');
    assert.equal(calls[0].params[5], '👍');
    assert.equal(calls[0].params[6], false);
    assert.equal(calls[1].params[5], null);
    assert.equal(calls[1].params[6], true, 'an empty emoji is a removal, not a delete');
    assert.match(
      calls[0].sql,
      /ON CONFLICT \(account, target_wa_message_id, reactor_jid\) DO UPDATE/,
      'one current reaction per reactor'
    );
    assert.match(
      calls[0].sql,
      /emoji = CASE WHEN EXCLUDED\.removed THEN whatsapp_message_reactions\.emoji/,
      'a removal keeps the last emoji'
    );
    assert.doesNotMatch(calls[0].sql, /DELETE/i);
  } finally {
    restore();
  }
});

test('reactions record the author side and never invent one on re-ingest', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const base = { targetMessageId: 'T', conversationId: '34600@c.us', emoji: '👍' };
    await storeMessageReaction({ ...base, reactorJid: '34600@c.us', fromMe: false });
    await storeMessageReaction({ ...base, reactorJid: '34999@c.us', fromMe: true });
    await storeMessageReaction({ ...base, reactorJid: '34600@c.us' });
    assert.equal(calls[0].params[7], false, 'a contact');
    assert.equal(calls[1].params[7], true, 'this account');
    assert.equal(calls[2].params[7], null, 'a key that never said stays unknown');
    assert.equal(calls[0].params[1], 'T', 'personal ids stay bare');
    assert.match(
      calls[0].sql,
      /from_me = COALESCE\(EXCLUDED\.from_me, whatsapp_message_reactions\.from_me\)/
    );
  } finally {
    restore();
  }
});

test('an older replayed reaction never overwrites a newer one', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const at = new Date(1_790_000_000_000);
    await storeMessageReaction({
      targetMessageId: 'T',
      conversationId: '34600@c.us',
      reactorJid: '34600@c.us',
      emoji: '❤️',
      reactedAt: at,
    });
    assert.equal(calls[0].params[8], at);
    assert.match(calls[0].sql, /EXCLUDED\.reacted_at >= whatsapp_message_reactions\.reacted_at/);
    assert.equal(reactionTime('1790000000123')?.getTime(), 1_790_000_000_123);
    assert.equal(reactionTime({ low: 1_000, high: 0 })?.getTime(), 1_000);
    assert.equal(reactionTime(null, 1_790_000_000)?.getTime(), 1_790_000_000_000);
    assert.equal(reactionTime(undefined), undefined);
  } finally {
    restore();
  }
});

test('incomplete input and DB errors never throw', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(() => new Error('connection reset'));
  try {
    assert.equal(
      await storeMessageReaction({
        targetMessageId: '',
        conversationId: 'c',
        reactorJid: 'r',
        emoji: 'x',
      }),
      false
    );
    assert.equal(calls.length, 0);
    assert.equal(
      await storeMessageReaction({
        targetMessageId: 'T',
        conversationId: 'c',
        reactorJid: 'r',
        emoji: 'x',
      }),
      false
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Ingest (a contact, our phone)
// ---------------------------------------------------------------------------

test('an inbound reaction is still ingested as a REACTION message AND recorded', async () => {
  useAccount('professional');
  // No messages row comes back: prod's merge_inbound_reaction trigger skips it.
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient();
    await priv(client).ingestMessage(
      reaction({ id: 'R1', target: 'T1', emoji: '👍', fromMe: false }),
      {
        source: 'live',
        publishEvent: false,
      }
    );
    const insert = calls.find(c => /INSERT INTO messages/i.test(c.sql))!;
    assert.equal(insert.params[6], 'REACTION', 'the legacy path is untouched');
    assert.equal(insert.params[5], '👍');
    assert.equal(insert.params[8], 'professional:T1');

    const [row] = reactionInserts(calls);
    assert.deepEqual(row.params, [
      'professional',
      'professional:T1',
      'professional:34600@c.us',
      'professional:34600@c.us',
      'professional:R1',
      '👍',
      false,
      false,
      new Date(1_790_000_000_000),
    ]);
  } finally {
    restore();
  }
});

test('a reaction from our phone is ours; a removal from a group LID participant is a removal', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient();
    await priv(client).ingestMessage(
      reaction({ id: 'R2', target: 'T1', emoji: '😂', fromMe: true }),
      { source: 'baileys_history_sync', publishEvent: false }
    );
    await priv(client).ingestMessage(
      reaction({
        id: 'R3',
        target: 'G1',
        emoji: '',
        fromMe: false,
        remoteJid: '120363000@g.us',
        participant: '4455@lid',
      }),
      { source: 'live', publishEvent: false }
    );
    const [mine, removal] = reactionInserts(calls);
    assert.equal(mine.params[2], '34999@c.us', 'reactor = our own jid');
    assert.equal(mine.params[7], true);
    assert.equal(removal.params[1], 'G1');
    assert.equal(removal.params[2], '4455@lid');
    assert.equal(removal.params[3], '120363000@g.us');
    assert.equal(removal.params[5], null);
    assert.equal(removal.params[6], true);
  } finally {
    restore();
  }
});

test('with the table missing the REACTION message is still ingested; logged once, re-probed later', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(sql => (isReactionInsert(sql) ? missingTable() : []));
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (msg: string) => void warned.push(String(msg));
  try {
    const { client } = makeClient();
    for (const id of ['R1', 'R2']) {
      await priv(client).ingestMessage(reaction({ id, target: 'T1', emoji: '👍', fromMe: false }), {
        source: 'live',
        publishEvent: false,
      });
    }
    assert.equal(calls.filter(c => /INSERT INTO messages/i.test(c.sql)).length, 2);
    assert.equal(reactionInserts(calls).length, 1, 'the second one skips the DB (known missing)');
    assert.equal(warned.filter(w => /migration 011/.test(w)).length, 1);
  } finally {
    console.warn = warn;
    restore();
  }
});

test('with ingest off (pairing pool) a reaction is never written', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client, sent } = makeClient({ ingest: false });
    await priv(client).persistReaction(reaction({ id: 'R1', target: 'T1', emoji: '👍' }), {
      conversationId: '34600@c.us',
      senderWaId: '34600@c.us',
    });
    const key = { remoteJid: '34600@s.whatsapp.net', id: 'MEM', fromMe: false };
    priv(client).rememberKey('MEM', key, key.remoteJid);
    await client.reactToMessage('34600@c.us', 'MEM', '👍');
    assert.equal(sent.length, 1, 'it still reacts from memory');
    assert.equal(calls.length, 0, 'the pairing pool never touches the DB');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// reactToMessage
// ---------------------------------------------------------------------------

test('react after a restart uses the stored key and records our reaction', async () => {
  useAccount('professional');
  // Nothing in memory: the key comes from whatsapp_message_keys.
  const { calls, restore } = stubPool(sql =>
    isStoredSelect(sql) ? storedRow({ wa_message_id: 'professional:M1' }) : []
  );
  try {
    const { client, sent } = makeClient();
    const result = await client.reactToMessage('professional:34600@lid', 'professional:M1', ' ❤️ ');

    assert.deepEqual(sent, [
      {
        jid: '34600@lid',
        content: {
          react: {
            text: '❤️',
            key: { remoteJid: '34600@lid', fromMe: false, participant: undefined, id: 'M1' },
          },
        },
      },
    ]);
    const [row] = reactionInserts(calls);
    assert.deepEqual(row.params, [
      'professional',
      'professional:M1',
      'professional:34999@c.us',
      'professional:34600@lid',
      'professional:REACT1',
      '❤️',
      false,
      true,
      new Date(SENT_REACTION_MS),
    ]);
    assert.deepEqual(result, {
      messageId: 'M1',
      reactionId: 'REACT1',
      emoji: '❤️',
      reactedAt: new Date(SENT_REACTION_MS).toISOString(),
    });
  } finally {
    restore();
  }
});

test('react prefers the durable payload key (group message of a contact keeps its participant)', async () => {
  useAccount('personal');
  const { restore } = stubPool(sql => {
    if (isPayloadSelect(sql))
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
          message_payload: JSON.parse(
            serializeDurableValue(toDurablePayload({ conversation: 'x' }))
          ),
          wa_timestamp: new Date(1_700_000_000_000),
          push_name: null,
        },
      ];
    return [];
  });
  try {
    const { client, sent } = makeClient();
    await client.reactToMessage('120363000@g.us', 'G1', '');
    assert.equal(sent[0].jid, '120363000@g.us');
    assert.deepEqual(sent[0].content.react, {
      text: '',
      key: { remoteJid: '120363000@g.us', id: 'G1', fromMe: false, participant: '4455@lid' },
    });
  } finally {
    restore();
  }
});

test('react to an unknown message is a 404 message_unavailable and sends nothing', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client, sent } = makeClient();
    await assert.rejects(
      client.reactToMessage('34600@c.us', 'NOPE', '👍'),
      (e: unknown) =>
        e instanceof MessageUnavailableError &&
        e.status === 404 &&
        e.failureClass === 'message_unavailable'
    );
    assert.equal(sent.length, 0);
    assert.equal(reactionInserts(calls).length, 0);
  } finally {
    restore();
  }
});

test('with the table missing a reaction still goes out', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(sql => {
    if (isReactionInsert(sql)) return missingTable();
    return isStoredSelect(sql) ? storedRow() : [];
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { client, sent } = makeClient();
    const result = await client.reactToMessage('34600@lid', 'M1', '👍');
    assert.equal(sent.length, 1);
    assert.equal(result.reactionId, 'REACT1');
    assert.equal(reactionInserts(calls).length, 1);
  } finally {
    console.warn = warn;
    restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Call = (body: unknown) => Promise<Response>;

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
  const call: Call = body => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}/api/v1/messages/react`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(ts),
        'x-connector-signature': generateHMACSignature(body ?? {}, ts, secret),
      },
      body: JSON.stringify(body),
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
    reactToMessage: async (chatId: string, id: string, emoji: string) => {
      seen.push(`${chatId}:${id}:${emoji}`);
      return {
        messageId: 'M1',
        reactionId: 'REACT1',
        emoji,
        reactedAt: '2026-09-29T10:00:00.000Z',
      };
    },
  };
  return { client: client as unknown as Partial<BaileysClient>, seen };
}

// What dgx-messages sends today.
const REACT = {
  conversationId: 'professional:34600@c.us',
  messageId: 'professional:M1',
  emoji: '👍',
};

test('HTTP: ENABLE_SENDING off or the emergency lock → 403 disabled_sending, never reaches WhatsApp', async () => {
  const { client, seen } = recordingClient();
  for (const env of [
    { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' },
  ]) {
    await withRouter(client, env, async call => {
      const res = await call(REACT);
      assert.equal(res.status, 403);
      assert.equal(
        ((await res.json()) as { failureClass: string }).failureClass,
        'disabled_sending'
      );
    });
  }
  assert.deepEqual(seen, []);
});

test('HTTP: 200 keeps the old shape (+ reactionId); empty or null emoji removes', async () => {
  const { client, seen } = recordingClient();
  await withRouter(
    client,
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined },
    async call => {
      const res = await call(REACT);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        reacted: true,
        emoji: '👍',
        messageId: 'professional:M1',
        reactionId: 'REACT1',
        reactedAt: '2026-09-29T10:00:00.000Z',
      });
      assert.equal((await call({ ...REACT, emoji: '' })).status, 200);
      assert.equal((await call({ ...REACT, emoji: null })).status, 200);
      assert.equal(
        (await call({ chatId: '34600@c.us', messageId: 'M1', emoji: '😮' })).status,
        200
      );
    }
  );
  assert.deepEqual(seen, [
    'professional:34600@c.us:professional:M1:👍',
    'professional:34600@c.us:professional:M1:',
    'professional:34600@c.us:professional:M1:',
    '34600@c.us:M1:😮',
  ]);
});

test('HTTP: 400 invalid, 503 disconnected, 404 message_unavailable with failureClass', async () => {
  const { client, seen } = recordingClient();
  let connected = true;
  Object.assign(client, {
    isConnected: () => connected,
    reactToMessage: async () => {
      throw new MessageUnavailableError('gone', 404, 'message_unavailable');
    },
  });
  await withRouter(
    client,
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined },
    async call => {
      for (const body of [{ messageId: 'M1' }, { conversationId: 'c' }, { ...REACT, emoji: 7 }]) {
        const res = await call(body);
        assert.equal(res.status, 400);
        assert.equal(
          ((await res.json()) as { failureClass: string }).failureClass,
          'invalid_request'
        );
      }
      const missing = await call(REACT);
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), {
        error: 'gone',
        failureClass: 'message_unavailable',
      });

      connected = false;
      const offline = await call(REACT);
      assert.equal(offline.status, 503);
      assert.equal(
        ((await offline.json()) as { failureClass: string }).failureClass,
        'disconnected'
      );
    }
  );
  assert.deepEqual(seen, []);
});
