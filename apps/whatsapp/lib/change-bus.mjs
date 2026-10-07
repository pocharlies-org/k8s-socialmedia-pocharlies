// Fan-out for PostgreSQL change hints (see migration 010).
//
// One dedicated LISTEN connection per app PROCESS, never per browser tab:
// every tab would otherwise hold its own server connection and Postgres runs
// out of them long before the browser runs out of tabs.
//
// The bus forwards identifiers only. Message content keeps flowing through the
// account-scoped read API, which owns visibility, LID/PN aliasing and provider
// state, so a pushed hint can never contradict a projected row.
import pg from 'pg';

export const REALTIME_CHANNEL = 'socialmedia_changes';

const HINT_KINDS = new Set(['message', 'chat']);
// An allowlist, so a future trigger field can never reach a browser by
// accident: anything not listed here is dropped, content included.
const HINT_FIELDS = ['kind', 'account', 'conversation_id', 'message_id', 'wa_message_id', 'reason'];

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!HINT_KINDS.has(raw.kind)) return null;
  const account = typeof raw.account === 'string' ? raw.account.slice(0, 128) : '';
  if (!account) return null;
  const event = { kind: raw.kind, account };
  for (const field of HINT_FIELDS) {
    if (field === 'kind' || field === 'account') continue;
    const value = raw[field];
    if (typeof value === 'string' && value) event[field] = value.slice(0, 512);
  }
  return event;
}

export function createChangeBus({
  connectionString = '',
  clientFactory = null,
  channel = REALTIME_CHANNEL,
  enabled = true,
  coalesceMs = 120,
  stormLimit = 50,
  stormWindowMs = 1000,
  reconnectBaseMs = 1000,
  reconnectMaxMs = 30000,
  setTimeoutRef = setTimeout,
  clearTimeoutRef = clearTimeout,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const channelName = /^[a-z_][a-z0-9_]*$/.test(channel) ? channel : REALTIME_CHANNEL;
  const makeClient = clientFactory
    || (connectionString
      ? () => new pg.Client({
          connectionString,
          application_name: 'socialmedia-whatsapp-app-events',
          connectionTimeoutMillis: 5000,
        })
      : null);
  const active = enabled === true && Boolean(makeClient);

  const subscriptions = new Set();
  const pending = new Map();
  const windowAccounts = new Set();
  let client = null;
  let connected = false;
  let everConnected = false;
  let closing = false;
  let started = false;
  let attempts = 0;
  let reconnectTimer = null;
  let flushTimer = null;
  let windowStart = null;
  let windowCount = 0;
  let delivered = 0;
  let discarded = 0;

  function deliver(event) {
    for (const subscription of Array.from(subscriptions)) {
      if (subscription.account && event.account && event.account !== subscription.account) continue;
      try { subscription.listener(event); }
      catch (error) { log(`subscriber failed: ${error?.message || error}`); }
    }
  }

  function flush() {
    flushTimer = null;
    const batch = Array.from(pending.values());
    pending.clear();
    for (const event of batch) { delivered += 1; deliver(event); }
  }

  // History sync and reconnect replays can commit thousands of rows in one
  // burst. Coalescing bounds the number of frames, not the number of reads a
  // burst causes, so past the limit a whole account collapses into one resync.
  function stormCollapsed(account) {
    const instant = now();
    if (windowStart === null || instant - windowStart > stormWindowMs) {
      windowStart = instant;
      windowCount = 0;
      windowAccounts.clear();
    }
    windowCount += 1;
    windowAccounts.add(account);
    if (windowCount < stormLimit) return false;
    const accounts = Array.from(windowAccounts);
    windowStart = instant;
    windowCount = 0;
    windowAccounts.clear();
    for (const [key, event] of Array.from(pending.entries())) {
      if (!accounts.includes(event.account)) continue;
      pending.delete(key);
    }
    for (const collapsed of accounts) deliver({ kind: 'resync', account: collapsed, reason: 'storm' });
    return true;
  }

  function accept(rawPayload) {
    let parsed;
    try { parsed = JSON.parse(rawPayload); }
    catch { discarded += 1; return; }
    const event = sanitize(parsed);
    if (!event) { discarded += 1; return; }
    if (stormCollapsed(event.account)) return;
    pending.set(`${event.kind}|${event.account}|${event.conversation_id || ''}`, event);
    if (!flushTimer) flushTimer = setTimeoutRef(flush, coalesceMs);
  }

  function scheduleReconnect(reason) {
    if (closing || !active || reconnectTimer) return;
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * (2 ** attempts));
    attempts += 1;
    log(`retrying in ${delay}ms (${reason})`);
    reconnectTimer = setTimeoutRef(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  function dropClient(dead) {
    connected = false;
    if (client && client !== dead) return;
    const previous = client;
    client = null;
    if (!previous) return;
    previous.removeAllListeners?.();
    previous.end().catch(() => {});
  }

  async function connect() {
    if (closing || !active || connected) return;
    let next;
    let failed = false;
    try { next = makeClient(); }
    catch (error) {
      scheduleReconnect(`client: ${error?.message || error}`);
      return;
    }
    next.on('notification', message => {
      if (closing || client !== next) return;
      accept(message.payload);
    });
    next.on('error', error => {
      if (closing) return;
      failed = true;
      log(`connection error: ${error?.message || error}`);
      dropClient(next);
      scheduleReconnect('connection error');
    });
    next.on('end', () => {
      failed = true;
      if (closing || client !== next) return;
      dropClient(next);
      scheduleReconnect('connection ended');
    });
    try {
      await next.connect();
      if (closing || failed) { await next.end().catch(() => {}); return; }
      // Never wrap LISTEN in a transaction: a listener that stays inside one
      // stops PostgreSQL from cleaning the notification queue.
      await next.query(`LISTEN "${channelName}"`);
    }
    catch (error) {
      try { next.removeAllListeners?.(); } catch { /* already gone */ }
      try { next.end().catch(() => {}); } catch { /* already gone */ }
      scheduleReconnect(error?.message || 'listen failed');
      return;
    }
    if (closing || failed) { await next.end().catch(() => {}); return; }
    client = next;
    connected = true;
    attempts = 0;
    log(`listening on ${channelName}`);
    // NOTIFY is not durable: anything committed while this connection was down
    // is gone, so every re-listen tells all subscribers to re-read.
    if (everConnected || subscriptions.size) {
      deliver({ kind: 'resync', account: null, reason: everConnected ? 'reconnect' : 'ready' });
    }
    everConnected = true;
  }

  return {
    enabled: active,
    start() {
      if (!active || closing) return false;
      if (!started) {
        started = true;
        void connect();
      }
      // True means "this bus is live", so a repeated start is idempotent.
      return true;
    },
    subscribe(account, listener) {
      const subscription = { account: account || null, listener };
      subscriptions.add(subscription);
      return () => subscriptions.delete(subscription);
    },
    state() {
      return {
        enabled: active,
        connected,
        reconnectAttempts: attempts,
        subscribers: subscriptions.size,
        delivered,
        discarded,
      };
    },
    async close() {
      if (closing) return;
      closing = true;
      if (reconnectTimer) { clearTimeoutRef(reconnectTimer); reconnectTimer = null; }
      if (flushTimer) { clearTimeoutRef(flushTimer); flushTimer = null; }
      pending.clear();
      subscriptions.clear();
      const live = client;
      client = null;
      connected = false;
      if (!live) return;
      live.removeAllListeners?.();
      try { await live.end(); } catch { /* already closed */ }
    },
  };
}
