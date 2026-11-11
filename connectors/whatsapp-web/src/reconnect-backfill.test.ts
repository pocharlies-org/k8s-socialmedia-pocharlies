/**
 * INFRA-288 (P1 of INFRA-112): bounded backfill of the window dropped between
 * a Baileys disconnect and the reconnect.
 *
 * Three criteria, no socket and no DB:
 *  A. volume/batch caps and the window asked for (newer-first anchors).
 *  B. defaults, defensive ceilings and OFF (a 0 flag = zero fetches).
 *  C. the replayed messages are ingested as source=baileys_history_sync with
 *     publishEvent=false, and only while the history window is armed.
 *
 * The fake sock captures the handlers bindSocketEvents registers, so the
 * connection.update / messaging-history.set branches run exactly as in prod.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysClient, reconnectBackfillLimitsFromEnv } from './baileys-client';
import { resetDurableStoreStateForTests } from './durable-message-store';

process.env.WA_DIRECT_PRIVACY_PREFLIGHT = 'false';

interface QueryCall {
  sql: string;
  params: unknown[];
}

interface FetchCall {
  count: number;
  key: { remoteJid: string; id: string; fromMe?: boolean };
  oldestTimestamp: number;
}

type Rows = Record<string, unknown>[];

/** Stub pg.Pool#query: `route` picks the rows by SQL; every call is captured. */
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

const isAnchorSelect = (sql: string): boolean => /FROM whatsapp_message_keys/i.test(sql);

/** A newer-first anchor row as pg returns it for one chat. */
function anchorRow(i: number, ageMinutes: number): Rows {
  return [
    {
      conversation_id: 'professional:34600@s.whatsapp.net',
      wa_message_id: `professional:MSG${i}`,
      remote_jid: '34600@s.whatsapp.net',
      from_me: false,
      participant_jid: null,
      message_timestamp_ms: new Date(Date.now() - ageMinutes * 60_000),
    },
  ];
}

/** Client with a fake sock whose ev.on captures the socket-event handlers. */
function makeClientWithSock(fetchCalls: FetchCall[]): {
  client: BaileysClient;
  handlers: Record<string, (update: any) => unknown>;
} {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16));
  const handlers: Record<string, (update: any) => unknown> = {};
  const sock = {
    ev: {
      on: (event: string, fn: (update: any) => unknown) => {
        handlers[event] = fn;
      },
    },
    fetchMessageHistory: async (count: number, key: any, oldestTimestamp: number) => {
      fetchCalls.push({ count, key, oldestTimestamp });
      return 'stub';
    },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean };
  internals.sock = sock;
  internals.ready = true;
  // Register the real handlers (connection.update, messaging-history.set, …)
  // against the fake sock, exactly as the connect() flow does.
  priv(client).bindSocketEvents(async () => {});
  return { client, handlers };
}

function priv(client: BaileysClient): any {
  return client as any;
}

/** Set the reconnect-backfill env for one test, restoring it afterwards. */
function useBackfillEnv(env: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Fire connection.update "open" and await the fire-and-forget backfill it starts. */
async function fireOpenAwaitBackfill(
  client: BaileysClient,
  handlers: Record<string, (update: any) => unknown>
): Promise<void> {
  const orig = priv(client).backfillReconnectWindow.bind(client);
  let started: Promise<unknown> | null = null;
  priv(client).backfillReconnectWindow = () => {
    started = orig();
    return started;
  };
  try {
    await handlers['connection.update']({ connection: 'open' });
    assert.ok(started, 'connection.update open must start the backfill');
    await started;
  } finally {
    delete priv(client).backfillReconnectWindow;
  }
}

// ---------------------------------------------------------------------------
// A. Volume cap, batch cap, window asked for
// ---------------------------------------------------------------------------

test('reconnect backfill caps total volume at MAX_MESSAGES in batches of <=50 and asks the configured window', async () => {
  const restoreEnv = useBackfillEnv({
    CONNECTOR_ACCOUNT: 'professional',
    WA_RECONNECT_BACKFILL_WINDOW_HOURS: '6',
    WA_RECONNECT_BACKFILL_MAX_MESSAGES: '120',
  });
  resetDurableStoreStateForTests();
  const fetchCalls: FetchCall[] = [];
  // 3 anchors → with max=120 and batch=50 the burst is 50, 50, 20.
  const { calls, restore } = stubPool(sql =>
    isAnchorSelect(sql) ? [...anchorRow(1, 30), ...anchorRow(2, 90), ...anchorRow(3, 150)] : []
  );
  try {
    const { client, handlers } = makeClientWithSock(fetchCalls);
    const before = Date.now();
    await fireOpenAwaitBackfill(client, handlers);

    assert.equal(fetchCalls.length, 3, 'one fetch per anchor, stopping at the volume cap');
    assert.deepEqual(
      fetchCalls.map(c => c.count),
      [50, 50, 20],
      'batch of 50 with the last request trimmed to the cap'
    );
    assert.ok(
      fetchCalls.reduce((s, c) => s + c.count, 0) <= 120,
      'total asked never exceeds WA_RECONNECT_BACKFILL_MAX_MESSAGES'
    );
    assert.ok(
      fetchCalls.every(c => c.count <= 50),
      'no individual request exceeds the 50-message batch'
    );

    const anchorQuery = calls.find(c => isAnchorSelect(c.sql))!;
    const windowStart = anchorQuery.params[0] as number;
    assert.ok(
      Math.abs(windowStart - (before - 6 * 60 * 60 * 1000)) < 10_000,
      `window param is now - 6h (got ${windowStart})`
    );
    assert.match(
      anchorQuery.sql,
      /message_timestamp_ms DESC/,
      'anchors are newer-first, not the oldest-first of backfillHistory'
    );
    assert.doesNotMatch(anchorQuery.sql, /message_timestamp_ms ASC/i);
    assert.match(anchorQuery.sql, /message_timestamp_ms <= \$1/, 'anchor at or before window start');
    // Shared DB: anchors must be scoped to THIS connector's account (the table
    // has no account column; the join on messages carries it).
    assert.match(
      anchorQuery.sql,
      /m\.account = \$2/,
      'anchors scoped to this connector account via messages join'
    );
    assert.equal(anchorQuery.params[1], 'professional');
    // The wire key is the bare id (namespaced rows stripped once).
    assert.equal(fetchCalls[0].key.id, 'MSG1');
    assert.equal(fetchCalls[0].key.remoteJid, '34600@s.whatsapp.net');
  } finally {
    restore();
    restoreEnv();
  }
});

// ---------------------------------------------------------------------------
// B. Defaults, ceilings and OFF
// ---------------------------------------------------------------------------

test('reconnectBackfillLimitsFromEnv: CTO defaults, ceilings and 0/negative = OFF', () => {
  assert.deepEqual(reconnectBackfillLimitsFromEnv({}), {
    windowMs: 6 * 60 * 60 * 1000,
    maxMessages: 500,
    batchSize: 50,
  });
  assert.equal(reconnectBackfillLimitsFromEnv({ WA_RECONNECT_BACKFILL_WINDOW_HOURS: '0' }), null);
  assert.equal(reconnectBackfillLimitsFromEnv({ WA_RECONNECT_BACKFILL_MAX_MESSAGES: '0' }), null);
  assert.equal(
    reconnectBackfillLimitsFromEnv({ WA_RECONNECT_BACKFILL_WINDOW_HOURS: '-1' }),
    null
  );
  assert.equal(
    reconnectBackfillLimitsFromEnv({ WA_RECONNECT_BACKFILL_MAX_MESSAGES: '-5' }),
    null
  );
  // Defensive ceilings: a misconfigured flag never asks for more than 24h / 1000.
  assert.equal(
    reconnectBackfillLimitsFromEnv({ WA_RECONNECT_BACKFILL_WINDOW_HOURS: '1000' })!.windowMs,
    24 * 60 * 60 * 1000
  );
  assert.equal(
    reconnectBackfillLimitsFromEnv({ WA_RECONNECT_BACKFILL_MAX_MESSAGES: '5000' })!.maxMessages,
    1000
  );
});

test('with the flags at 0 (OFF) connection.open fetches nothing and the backfill is a no-op', async () => {
  const restoreEnv = useBackfillEnv({
    CONNECTOR_ACCOUNT: 'professional',
    WA_RECONNECT_BACKFILL_WINDOW_HOURS: '0',
    WA_RECONNECT_BACKFILL_MAX_MESSAGES: '0',
  });
  resetDurableStoreStateForTests();
  const fetchCalls: FetchCall[] = [];
  const { restore } = stubPool();
  try {
    const { client, handlers } = makeClientWithSock(fetchCalls);
    await fireOpenAwaitBackfill(client, handlers);
    assert.equal(fetchCalls.length, 0, 'OFF means zero fetches, never unbounded history');
    assert.deepEqual(await client.backfillReconnectWindow(), { requested: 0, chats: 0 });
  } finally {
    restore();
    restoreEnv();
  }
});

// ---------------------------------------------------------------------------
// C. Replay is ingested as history-sync, not as live traffic
// ---------------------------------------------------------------------------

function historyMessage(id: string): WAMessage {
  return {
    key: { remoteJid: '34600@s.whatsapp.net', id, fromMe: false },
    message: { conversation: 'hola' },
    messageTimestamp: Math.floor(Date.now() / 1000) - 120,
  } as WAMessage;
}

test('messaging-history.set during the armed window ingests with source=baileys_history_sync and publishEvent=false, and with the window disarmed ingests nothing', async () => {
  const restoreEnv = useBackfillEnv({ CONNECTOR_ACCOUNT: 'professional' });
  resetDurableStoreStateForTests();
  const fetchCalls: FetchCall[] = [];
  const ingestCalls: { msg: WAMessage; options: any }[] = [];
  const { restore } = stubPool();
  try {
    const { client, handlers } = makeClientWithSock(fetchCalls);
    priv(client).ingestMessage = async (msg: WAMessage, options: any) => {
      ingestCalls.push({ msg, options });
      return { inserted: 0, waMessage: undefined };
    };

    // Window armed (same as backfillReconnectWindow does before fetching).
    priv(client).historyBackfillRequestedUntil = Date.now() + 60_000;
    await handlers['messaging-history.set']({
      chats: [],
      messages: [historyMessage('H1')],
      isLatest: false,
    });
    assert.equal(ingestCalls.length, 1);
    assert.equal(ingestCalls[0].msg.key.id, 'H1');
    assert.equal(ingestCalls[0].options.source, 'baileys_history_sync');
    assert.equal(ingestCalls[0].options.publishEvent, false);
    assert.equal(ingestCalls[0].options.isLatest, false);

    // Window disarmed: the same event is dropped (live traffic only path).
    priv(client).historyBackfillRequestedUntil = 0;
    await handlers['messaging-history.set']({
      chats: [],
      messages: [historyMessage('H2')],
      isLatest: false,
    });
    assert.equal(ingestCalls.length, 1, 'no ingest outside the armed window');
  } finally {
    restore();
    restoreEnv();
  }
});
