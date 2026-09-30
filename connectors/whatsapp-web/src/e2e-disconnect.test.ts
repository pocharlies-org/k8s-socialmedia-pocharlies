/**
 * INFRA-289 (P2 of INFRA-112): end-to-end of the outage cycle —
 * socket drops → a message is missed while down → the reconnect (real
 * scheduleReconnect timer, real reconnectNow, real bindSocketEvents) asks for
 * the bounded window from P1 → the phone replays it → it is ingested as
 * baileys_history_sync without re-publishing to NATS.
 *
 * No WhatsApp socket and no Postgres: pg.Pool#query is stubbed and the fake
 * sock captures the handlers bindSocketEvents registers, so the
 * connection.update / messaging-history.set branches run exactly as in prod.
 * Same scaffolding as src/reconnect-backfill.test.ts (P1).
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysClient } from './baileys-client';
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

const isAnchorSelect = (sql: string): boolean =>
  /FROM whatsapp_message_keys/i.test(sql) && !/INSERT/i.test(sql);

/** The one anchor of the chat '34600@s.whatsapp.net', newest-known at tsMs. */
function singleAnchor(tsMs: number): Rows {
  return [
    {
      conversation_id: 'professional:34600@s.whatsapp.net',
      wa_message_id: 'professional:MSG-OLD',
      remote_jid: '34600@s.whatsapp.net',
      from_me: false,
      participant_jid: null,
      message_timestamp_ms: new Date(tsMs),
    },
  ];
}

/** A fake sock whose ev.on captures the socket-event handlers. */
function makeSock(fetchCalls: FetchCall[]): {
  sock: any;
  handlers: Record<string, (update: any) => unknown>;
} {
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
  return { sock, handlers };
}

/** Client already holding sock A, with the real handlers bound to it. */
function makeClientWithSock(fetchCalls: FetchCall[]): {
  client: BaileysClient;
  handlers: Record<string, (update: any) => unknown>;
} {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16));
  const { sock, handlers } = makeSock(fetchCalls);
  const internals = client as unknown as { sock: unknown; ready: boolean };
  internals.sock = sock;
  internals.ready = true;
  priv(client).bindSocketEvents(async () => {});
  return { client, handlers };
}

/** Capture logger.info/warn/error into an array (the prod log lines are evidence). */
function captureLogger(client: BaileysClient): string[] {
  const logs: string[] = [];
  const record = (m: unknown) => {
    logs.push(String(m));
  };
  priv(client).logger = { info: record, warn: record, error: record, debug: record };
  return logs;
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

/** Poll until condition, no fixed sleeps; throws past the deadline. */
async function waitUntil(
  label: string,
  condition: () => boolean,
  timeoutMs = 15_000,
  stepMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `deadline (${timeoutMs}ms) reached: ${label}`);
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}

// ---------------------------------------------------------------------------
// 1. Full cycle: drop → missed message → reconnect → bounded backfill ingests it
// ---------------------------------------------------------------------------

test('E2E: socket drops, a message arrives during the outage, the reconnect backfill ingests it as baileys_history_sync', async () => {
  const restoreEnv = useBackfillEnv({
    CONNECTOR_ACCOUNT: 'professional',
    WA_RECONNECT_BACKFILL_WINDOW_HOURS: '6',
    WA_RECONNECT_BACKFILL_MAX_MESSAGES: '500',
  });
  resetDurableStoreStateForTests();

  // Phase 1: client with sock A, capturing logger, counting NATS publishes.
  const fetchCalls: FetchCall[] = [];
  const anchorTsMs = Date.now() - 9 * 60_000;
  let anchorsAvailable = false;
  const { calls, restore } = stubPool(sql =>
    anchorsAvailable && isAnchorSelect(sql) ? singleAnchor(anchorTsMs) : []
  );
  let messageEvents = 0;
  try {
    const { client, handlers } = makeClientWithSock(fetchCalls);
    const logs = captureLogger(client);
    client.on('message', () => {
      messageEvents += 1;
    });

    // Phase 2: connected burst with a freshly-seeded DB (zero anchors) →
    // the open branch asks for nothing.
    await fireOpenAwaitBackfill(client, handlers);
    assert.equal(fetchCalls.length, 0, 'no anchors in the DB → the first open fetches nothing');

    // Phase 3: model uptime. P1's cooldown of 60s between bursts is real, so
    // to reach the case the epic cares about (the socket had been open for a
    // while and THEN dropped) we rewind lastReconnectBackfillAt 10 minutes.
    priv(client).lastReconnectBackfillAt = Date.now() - 10 * 60_000;

    // Phase 4: the chat has one known key from before the outage — from now
    // on the anchor SELECT returns it.
    anchorsAvailable = true;

    // Phase 5: the socket drops. close → ready=false, CLOSED:x, reconnect armed.
    await handlers['connection.update']({
      connection: 'close',
      lastDisconnect: { error: new Error('Connection close (restart)') },
    });
    assert.equal(priv(client).ready, false, 'close clears ready');
    assert.match(String(priv(client).lastState), /^CLOSED:/, 'lastState is CLOSED:<code>');
    assert.ok(priv(client).reconnectTimer != null, 'scheduleReconnect armed a retry');

    // Phase 6: the reconnect happens FOR REAL through the timer. Only
    // connect() is stubbed: it installs a brand-new sock B and runs the real
    // bindSocketEvents, as the real connect does. The 5s first-retry delay of
    // scheduleReconnect is part of what is exercised — the timer is NOT
    // cleared, we poll until it fires.
    const sockB = makeSock(fetchCalls);
    client.connect = async () => {
      priv(client).sock = sockB.sock;
      priv(client).bindSocketEvents(async () => {});
    };
    await waitUntil('scheduleReconnect timer fired and reconnectNow installed sock B', () =>
      Boolean(sockB.handlers['connection.update'])
    );
    assert.equal(fetchCalls.length, 0, 'sock A never asked for history');
    assert.equal(priv(client).sock, sockB.sock, 'reconnectNow replaced the socket');

    // Phase 7: sock B opens → the bounded window is asked from the anchor.
    const beforeOpen = Date.now();
    await fireOpenAwaitBackfill(client, sockB.handlers);
    assert.equal(fetchCalls.length, 1, 'exactly one fetchMessageHistory burst per reconnect');
    const fetch = fetchCalls[0];
    assert.ok(fetch.count <= 50, `batch stays <= 50 (got ${fetch.count})`);
    assert.equal(fetch.key.id, 'MSG-OLD', 'wire key is bare, no account prefix');
    assert.equal(fetch.key.remoteJid, '34600@s.whatsapp.net');
    assert.equal(fetch.oldestTimestamp, Math.floor(anchorTsMs / 1000));
    const anchorQuery = calls.find(c => isAnchorSelect(c.sql))!;
    assert.ok(
      Math.abs((anchorQuery.params[0] as number) - (beforeOpen - 6 * 60 * 60 * 1000)) < 10_000,
      `anchors asked from now - 6h (got ${anchorQuery.params[0]})`
    );
    assert.equal(anchorQuery.params[1], 'professional', 'anchors scoped to this account');

    // Phase 8: the phone answers with the message that arrived during the
    // outage, via messaging-history.set on sock B.
    await sockB.handlers['messaging-history.set']({
      chats: [],
      messages: [
        {
          key: { remoteJid: '34600@s.whatsapp.net', id: 'MSG-DROPPED', fromMe: false },
          message: { conversation: 'prueba INFRA-289' },
          messageTimestamp: Math.floor((Date.now() - 4 * 60_000) / 1000),
        } as WAMessage,
      ],
      isLatest: false,
    });

    // Phase 9: the ingest evidence (the same lines/signals measured in prod).
    assert.ok(
      logs.some(l => l.includes('history.set received chats=0 messages=1 isLatest=false')),
      `history.set log line present as in prod (logs: ${JSON.stringify(logs)})`
    );
    const msgInsert = calls.find(c => /INSERT INTO messages/i.test(c.sql))!;
    assert.ok(msgInsert, 'the replayed message reaches the messages INSERT');
    assert.equal(msgInsert.params[0], 'professional:MSG-DROPPED');
    assert.equal(msgInsert.params[1], 'professional:34600@c.us');
    assert.match(String(msgInsert.params[10]), /baileys_history_sync/);
    assert.equal(msgInsert.params[11], 'professional');
    const keyInsert = calls.find(c => /INSERT INTO whatsapp_message_keys/i.test(c.sql))!;
    assert.ok(keyInsert, 'the key is stored so the next outage anchors on it');
    assert.equal(keyInsert.params[0], 'professional:MSG-DROPPED');
    assert.equal(messageEvents, 0, 'a replay is never re-published to NATS');
    assert.equal(fetchCalls.length, 1, 'one burst for the client lifetime');
  } finally {
    restore();
    restoreEnv();
  }
});

// ---------------------------------------------------------------------------
// 2. Flapping inside the cooldown asks for history once, never twice
// ---------------------------------------------------------------------------

test('E2E: a reconnect flap inside the 60s cooldown asks for history once, never twice', async () => {
  const restoreEnv = useBackfillEnv({
    CONNECTOR_ACCOUNT: 'professional',
    WA_RECONNECT_BACKFILL_WINDOW_HOURS: '6',
    WA_RECONNECT_BACKFILL_MAX_MESSAGES: '500',
  });
  resetDurableStoreStateForTests();
  const fetchCalls: FetchCall[] = [];
  const anchorTsMs = Date.now() - 9 * 60_000;
  const { restore } = stubPool(sql => (isAnchorSelect(sql) ? singleAnchor(anchorTsMs) : []));
  const { client, handlers } = makeClientWithSock(fetchCalls);
  try {
    // This test never lets the reconnect timer reach connect(): the flap is
    // fired by hand on the same sock, and a real connect is unthinkable here.
    client.connect = async () => {};

    // First open: the window is asked once.
    await fireOpenAwaitBackfill(client, handlers);
    assert.equal(fetchCalls.length, 1, 'first open asks for the window');

    // Flap: close + open back to back on the same sock, cooldown not expired.
    await handlers['connection.update']({
      connection: 'close',
      lastDisconnect: { error: new Error('flap') },
    });
    await handlers['connection.update']({ connection: 'open' });
    assert.equal(fetchCalls.length, 1, 'the flap inside the cooldown fetches nothing');
    assert.deepEqual(
      await client.backfillReconnectWindow(),
      { requested: 0, chats: 0 },
      'cooldown: the burst is a no-op'
    );

    // Cooldown expires: the same window is asked again.
    priv(client).lastReconnectBackfillAt = Date.now() - 61_000;
    const again = await client.backfillReconnectWindow();
    assert.equal(again.requested, 50);
    assert.equal(fetchCalls.length, 2, 'past the cooldown the window is asked again');
  } finally {
    const timer = priv(client).reconnectTimer;
    if (timer) {
      clearTimeout(timer);
      priv(client).reconnectTimer = null;
    }
    restore();
    restoreEnv();
  }
});
