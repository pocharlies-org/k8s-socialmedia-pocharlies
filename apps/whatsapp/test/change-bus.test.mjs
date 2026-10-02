import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createChangeBus, REALTIME_CHANNEL } from '../lib/change-bus.mjs';

// The bus is driven entirely by injected timers so coalescing, storm collapse
// and backoff are asserted without waiting on the wall clock.
function fakeClock() {
  let time = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout: (fn, ms) => {
      const key = ++sequence;
      timers.set(key, { at: time + (ms || 0), fn });
      return key;
    },
    clearTimeout: key => { timers.delete(key); },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = Array.from(timers.entries())
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (!due.length) break;
        const [key, timer] = due[0];
        timers.delete(key);
        time = timer.at;
        timer.fn();
      }
      time = target;
    },
    get pendingTimers() { return timers.size; },
  };
}

class FakeClient extends EventEmitter {
  constructor(state) {
    super();
    this.state = state;
    this.queries = [];
    this.ended = false;
  }
  async connect() {
    this.state.connects += 1;
    if (this.state.failConnect) throw Error('connect refused');
  }
  async query(sql) { this.queries.push(sql); }
  async end() { this.ended = true; this.emit('end'); }
  notify(payload) { this.emit('notification', { payload }); }
}

function harness(options = {}) {
  const clock = fakeClock();
  const clients = [];
  const state = { connects: 0, failConnect: false };
  const bus = createChangeBus({
    clientFactory: () => { const client = new FakeClient(state); clients.push(client); return client; },
    setTimeoutRef: clock.setTimeout,
    clearTimeoutRef: clock.clearTimeout,
    now: clock.now,
    coalesceMs: 10,
    reconnectBaseMs: 1000,
    ...options,
  });
  return { bus, clock, clients, state };
}

// connect() is async, so give it the microtask queue before asserting.
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

test('one LISTEN per process and repeated start stays a no-op', async () => {
  const { bus, clients } = harness();
  assert.equal(bus.start(), true);
  assert.equal(bus.start(), true);
  await settle();
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0].queries, [`LISTEN "${REALTIME_CHANNEL}"`]);
  assert.equal(bus.state().connected, true);
  assert.equal(bus.enabled, true);
  await bus.close();
});

test('identical hints coalesce into one frame carrying identifiers only', async () => {
  const { bus, clock, clients } = harness();
  const events = [];
  bus.subscribe('personal', event => events.push(event));
  bus.start();
  await settle();
  events.length = 0;
  const payload = JSON.stringify({
    kind: 'message', account: 'personal', conversation_id: '346000@lid',
    message_id: 'm-1', wa_message_id: 'WA1', reason: 'insert', content: 'texto privado',
  });
  clients[0].notify(payload);
  clients[0].notify(payload);
  clients[0].notify(payload);
  clock.advance(10);
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ['account', 'conversation_id', 'kind', 'message_id', 'reason', 'wa_message_id']);
  assert.equal(events[0].content, undefined);
  await bus.close();
});

test('distinct chats stay distinct hints and other accounts never wake this subscriber', async () => {
  const { bus, clock, clients } = harness();
  const personal = [];
  bus.subscribe('personal', event => personal.push(event));
  bus.start();
  await settle();
  personal.length = 0;
  clients[0].notify(JSON.stringify({ kind: 'chat', account: 'secondary', conversation_id: 'x@g.us' }));
  clients[0].notify(JSON.stringify({ kind: 'message', account: 'personal', conversation_id: 'a@lid' }));
  clients[0].notify(JSON.stringify({ kind: 'message', account: 'personal', conversation_id: 'b@lid' }));
  clock.advance(10);
  assert.deepEqual(personal.map(event => event.conversation_id), ['a@lid', 'b@lid']);
  await bus.close();
});

test('a committed reaction hint refreshes only its owning account without leaking emoji', async () => {
  const { bus, clock, clients } = harness();
  const personal = [];
  const secondary = [];
  bus.subscribe('personal', event => personal.push(event));
  bus.subscribe('secondary', event => secondary.push(event));
  bus.start();
  await settle();
  personal.length = 0;
  secondary.length = 0;
  clients[0].notify(JSON.stringify({
    kind: 'message', account: 'secondary', conversation_id: 'secondary:chat',
    message_id: 'target', wa_message_id: 'secondary:target', reason: 'reaction',
    emoji: 'private', reactor_jid: 'private',
  }));
  clock.advance(10);
  assert.deepEqual(personal, []);
  assert.deepEqual(secondary, [{
    kind: 'message', account: 'secondary', conversation_id: 'secondary:chat',
    message_id: 'target', wa_message_id: 'secondary:target', reason: 'reaction',
  }]);
  await bus.close();
});

test('unparsable or unrecognised payloads are discarded without stopping the bus', async () => {
  const { bus, clock, clients } = harness();
  const events = [];
  bus.subscribe('personal', event => events.push(event));
  bus.start();
  await settle();
  events.length = 0;
  clients[0].notify('not json');
  clients[0].notify(JSON.stringify({ kind: 'typing', account: 'personal' }));
  clients[0].notify(JSON.stringify({ kind: 'message', account: '' }));
  clients[0].notify(JSON.stringify({ kind: 'message', account: 'personal', conversation_id: 'a@lid' }));
  clock.advance(10);
  assert.equal(events.length, 1);
  assert.equal(bus.state().discarded, 3);
  await bus.close();
});

test('a burst collapses to one resync per account instead of a frame storm', async () => {
  const { bus, clock, clients } = harness({ stormLimit: 3 });
  const events = [];
  bus.subscribe('personal', event => events.push(event));
  bus.start();
  await settle();
  events.length = 0;
  for (const chat of ['a@lid', 'b@lid', 'c@lid']) {
    clients[0].notify(JSON.stringify({ kind: 'message', account: 'personal', conversation_id: chat }));
  }
  assert.deepEqual(events, [{ kind: 'resync', account: 'personal', reason: 'storm' }]);
  clock.advance(10);
  assert.equal(events.length, 1);
  await bus.close();
});

test('connection loss re-listens and every re-listen resyncs subscribers', async () => {
  const { bus, clock, clients } = harness();
  const events = [];
  bus.subscribe('personal', event => events.push(event));
  bus.start();
  await settle();
  events.length = 0;
  clients[0].emit('error', Error('server went away'));
  assert.equal(bus.state().connected, false);
  assert.equal(clients[0].ended, true);
  clock.advance(1000);
  await settle();
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[1].queries, [`LISTEN "${REALTIME_CHANNEL}"`]);
  assert.deepEqual(events, [{ kind: 'resync', account: null, reason: 'reconnect' }]);
  await bus.close();
});

test('reconnect backoff waits the scheduled delay before dialling again', async () => {
  const { bus, clock, clients, state } = harness();
  state.failConnect = true;
  bus.start();
  await settle();
  assert.equal(clients.length, 1);
  assert.equal(clients[0].queries.length, 0);
  clock.advance(999);
  await settle();
  assert.equal(clients.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(clients.length, 2);
  clock.advance(2000);
  await settle();
  assert.equal(clients.length, 3, 'the second attempt doubles the delay');
  await bus.close();
});

test('a subscriber that connects before LISTEN is ready gets an initial resync', async () => {
  let finishConnect;
  const clients = [];
  const bus = createChangeBus({
    clientFactory: () => {
      const client = new FakeClient({ connects: 0 });
      const connect = client.connect.bind(client);
      client.connect = () => new Promise(resolve => { finishConnect = async () => { await connect(); resolve(); }; });
      clients.push(client);
      return client;
    },
  });
  const events = [];
  bus.start();
  bus.subscribe('personal', event => events.push(event));
  await settle();
  await finishConnect();
  await settle();
  assert.deepEqual(events, [{ kind: 'resync', account: null, reason: 'ready' }]);
  await bus.close();
});

test('closing during a pending connection does not leave a LISTEN client alive', async () => {
  let finishConnect;
  let pendingClient;
  const bus = createChangeBus({
    clientFactory: () => {
      pendingClient = new FakeClient({ connects: 0 });
      pendingClient.connect = () => new Promise(resolve => { finishConnect = resolve; });
      return pendingClient;
    },
  });
  bus.start();
  await settle();
  await bus.close();
  finishConnect();
  await settle();
  assert.equal(pendingClient.ended, true);
  assert.deepEqual(pendingClient.queries, []);
  assert.equal(bus.state().connected, false);
});

test('close drops timers, ends the connection and ignores late hints', async () => {
  const { bus, clock, clients } = harness();
  const events = [];
  const unsubscribe = bus.subscribe('personal', event => events.push(event));
  const started = bus.start();
  assert.equal(started, true);
  await settle();
  events.length = 0;
  clients[0].notify(JSON.stringify({ kind: 'message', account: 'personal', conversation_id: 'a@lid' }));
  await bus.close();
  await bus.close();
  assert.equal(clients[0].ended, true);
  assert.equal(clock.pendingTimers, 0, 'no timer may keep the process alive after close');
  assert.equal(bus.state().connected, false);
  clients[0].notify(JSON.stringify({ kind: 'message', account: 'personal', conversation_id: 'b@lid' }));
  clock.advance(100);
  assert.deepEqual(events, []);
  assert.equal(unsubscribe(), false, 'the subscriber set is already gone');
});

test('a bus without a connection string stays disabled and opens nothing', async () => {
  const disabled = createChangeBus({
    connectionString: '',
    setTimeoutRef: () => 1,
    clearTimeoutRef: () => {},
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.start(), false);
  const events = [];
  disabled.subscribe('personal', event => events.push(event));
  await disabled.close();
  assert.deepEqual(events, []);
  assert.equal(disabled.state().connected, false);
});
