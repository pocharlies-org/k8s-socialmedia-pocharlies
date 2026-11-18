import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveUpdates} from '../public/live-updates.mjs';

function fixture() {
  const sources = [];
  const calls = [];
  const hints = [];
  const intervals = new Map();
  const timeouts = new Map();
  const listeners = new Map();
  let nextTimer = 0;
  const documentRef = {
    hidden: false,
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const updates = createLiveUpdates({
    documentRef,
    refresh: async context => { calls.push(context); },
    onHint: hint => { hints.push(hint); },
    eventSource: url => {
      const source = {url, readyState: 1, closed: false, listeners: new Map(),
        addEventListener(type, callback) { this.listeners.set(type, callback); },
        close() { this.closed = true; }};
      sources.push(source);
      return source;
    },
    setIntervalRef: callback => { intervals.set(++nextTimer, callback); return nextTimer; },
    clearIntervalRef: id => intervals.delete(id),
    setTimeoutRef: callback => { timeouts.set(++nextTimer, callback); return nextTimer; },
    clearTimeoutRef: id => timeouts.delete(id),
  });
  const flush = async () => {
    const callbacks = [...timeouts.values()];
    timeouts.clear();
    for (const callback of callbacks) callback();
    await new Promise(resolve => setImmediate(resolve));
  };
  return {updates, sources, calls, hints, intervals, timeouts, listeners, documentRef, flush};
}

test('reaction hints reach the UI once for the active account while refresh still coalesces', async () => {
  const item = fixture();
  item.updates.start('secondary');
  item.sources[0].onopen();
  await item.flush();
  item.hints.length = 0;
  item.calls.length = 0;
  const reaction = {account:'secondary', conversation_id:'secondary:chat', wa_message_id:'secondary:target', reason:'reaction-to-own-message'};
  item.sources[0].listeners.get('message')({data:JSON.stringify(reaction)});
  item.sources[0].listeners.get('message')({data:JSON.stringify({...reaction, account:'personal'})});
  await item.flush();
  assert.deepEqual(item.hints, [reaction]);
  assert.equal(item.calls.length, 1);
  item.updates.start('personal');
  item.sources[0].listeners.get('message')({data:JSON.stringify(reaction)});
  assert.deepEqual(item.hints, [reaction], 'a closed stream cannot deliver stale hints');
  item.updates.destroy();
});

test('a notification handler failure cannot stop the message refresh', async () => {
  let refreshes = 0;
  let source;
  const timers = [];
  const updates = createLiveUpdates({
    refresh: async () => { refreshes += 1; },
    onHint: () => { throw Error('notifications unavailable'); },
    documentRef: { hidden: true, addEventListener() {}, removeEventListener() {} },
    eventSource: () => (source = {addEventListener(type, listener) { this[type] = listener; }, close() {}}),
    setIntervalRef: () => 1,
    clearIntervalRef: () => {},
    setTimeoutRef: callback => { timers.push(callback); return timers.length; },
    clearTimeoutRef: () => {},
  });
  updates.start('personal');
  source.message({data:'{"account":"personal","reason":"reaction-to-own-message"}'});
  for (const timer of timers) timer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1);
  updates.destroy();
});

test('SSE coalesces change hints, filters accounts and resyncs after opening', async () => {
  const item = fixture();
  item.updates.start('personal');
  assert.equal(item.sources[0].url, '/api/events?account=personal');
  assert.equal(item.intervals.size, 1, 'polling covers connection setup');
  item.sources[0].onopen();
  assert.equal(item.intervals.size, 0);
  await item.flush();
  assert.deepEqual(item.calls, [{account:'personal', hidden:false, conversations:null}]);
  for (let i = 0; i < 3; i++) item.sources[0].listeners.get('message')({data:JSON.stringify({account:'personal'})});
  item.sources[0].listeners.get('chat')({data:JSON.stringify({account:'secondary'})});
  await item.flush();
  assert.equal(item.calls.length, 2, 'a burst refreshes only once');
  item.documentRef.hidden = true;
  item.listeners.get('visibilitychange')();
  assert.equal(item.timeouts.size, 0, 'hidden tabs do not trigger visibility refreshes');
  item.documentRef.hidden = false;
  item.listeners.get('visibilitychange')();
  await item.flush();
  assert.equal(item.calls.length, 3);
  item.updates.destroy();
  assert.equal(item.listeners.size, 0);
});

test('switching accounts closes the old stream and a failed stream restores polling', async () => {
  const item = fixture();
  item.updates.start('personal');
  item.updates.start('secondary');
  assert.equal(item.sources[0].closed, true);
  item.sources[0].listeners.get('message')({data:'{"account":"personal"}'});
  await item.flush();
  assert.equal(item.calls.length, 0, 'stale account events are ignored');
  item.sources[1].onopen();
  await item.flush();
  assert.deepEqual(item.calls, [{account:'secondary', hidden:false, conversations:null}]);
  item.sources[1].readyState = 2;
  item.sources[1].onerror();
  assert.equal(item.intervals.size, 1);
  assert.equal(item.sources[1].closed, true);
  await item.flush();
  assert.equal(item.sources.length, 3, 'a closed EventSource reconnects');
  for (const tick of item.intervals.values()) tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.calls.at(-1).account, 'secondary');
  item.updates.destroy();
  assert.equal(item.intervals.size, 0);
});

test('an unavailable EventSource keeps polling and retries without aborting the app', async () => {
  const intervals = new Map();
  const timeouts = new Map();
  const calls = [];
  let nextTimer = 0;
  const updates = createLiveUpdates({
    documentRef:{hidden:false, addEventListener() {}, removeEventListener() {}},
    refresh: async context => calls.push(context),
    eventSource: () => { throw Error('EventSource unavailable'); },
    setIntervalRef: callback => { intervals.set(++nextTimer, callback); return nextTimer; },
    clearIntervalRef: id => intervals.delete(id),
    setTimeoutRef: callback => { timeouts.set(++nextTimer, callback); return nextTimer; },
    clearTimeoutRef: id => timeouts.delete(id),
  });
  updates.start('personal');
  assert.equal(intervals.size, 1);
  assert.equal(timeouts.size, 1);
  for (const tick of intervals.values()) tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [{account:'personal',hidden:false, conversations:null}]);
  updates.destroy();
  assert.equal(intervals.size, 0);
  assert.equal(timeouts.size, 0);
});

test('an event during a fetch schedules another refresh so the last change is not lost', async () => {
  const item = fixture();
  let finishFirst;
  const first = new Promise(resolve => { finishFirst = resolve; });
  const calls = [];
  item.updates.destroy();
  const updates = createLiveUpdates({
    documentRef:item.documentRef,
    refresh: async () => { calls.push('read'); if (calls.length === 1) await first; },
    eventSource: () => item.sources[0] = {readyState:1, addEventListener(type, callback) { this[type] = callback; }, close() {}},
    setIntervalRef: callback => { item.intervals.set(1, callback); return 1; },
    clearIntervalRef: id => item.intervals.delete(id),
    setTimeoutRef: callback => { item.timeouts.set(2, callback); return 2; },
    clearTimeoutRef: id => item.timeouts.delete(id),
  });
  updates.start('personal');
  item.sources[0].onopen();
  await item.flush();
  assert.equal(calls.length, 1);
  item.sources[0].message({data:'{"account":"personal"}'});
  await item.flush();
  assert.equal(calls.length, 1, 'the pending read is not overlapped');
  finishFirst();
  await new Promise(resolve => setImmediate(resolve));
  await item.flush();
  assert.equal(calls.length, 2, 'the later change is read after the first query');
  updates.destroy();
});

test('un hint dirigido refresca solo sus chats y un resync vuelve a la recarga completa', async () => {
  const item = fixture();
  item.updates.start('personal');
  item.sources[0].onopen();
  await item.flush();
  item.calls.length = 0;
  item.sources[0].listeners.get('message')({data:JSON.stringify({account:'personal', conversation_id:'a@lid'})});
  item.sources[0].listeners.get('chat')({data:JSON.stringify({account:'personal', conversation_id:'b@g.us'})});
  await item.flush();
  assert.deepEqual(item.calls, [{account:'personal', hidden:false, conversations:['a@lid','b@g.us']}],
    'las conversaciones anunciadas viajan juntas, una sola pasada');
  item.calls.length = 0;
  item.sources[0].listeners.get('resync')({data:JSON.stringify({account:'personal', reason:'reconnect'})});
  await item.flush();
  assert.deepEqual(item.calls, [{account:'personal', hidden:false, conversations:null}]);
  item.updates.destroy();
});

test('demasiadas filas anunciadas vuelven a la recarga: un listado cuesta menos que N lecturas', async () => {
  const item = fixture();
  item.updates.start('personal');
  item.sources[0].onopen();
  await item.flush();
  item.calls.length = 0;
  for (let i = 0; i < 9; i++) {
    item.sources[0].listeners.get('message')({data:JSON.stringify({account:'personal', conversation_id:`${i}@lid`})});
  }
  await item.flush();
  assert.equal(item.calls[0].conversations, null);
  item.updates.destroy();
});

test('la reconexión crece con backoff y live() solo es cierto con el stream abierto', () => {
  const scheduled = [];
  const sources = [];
  let next = 0;
  const updates = createLiveUpdates({
    documentRef: {hidden: false, addEventListener() {}, removeEventListener() {}},
    refresh: async () => {},
    eventSource: () => {
      const source = {readyState: 1, addEventListener(type, cb) { this[type] = cb; }, close() { this.readyState = 2; }};
      sources.push(source);
      return source;
    },
    setIntervalRef: () => ++next,
    clearIntervalRef: () => {},
    setTimeoutRef: (cb, ms) => { scheduled.push({cb, ms}); return ++next; },
    clearTimeoutRef: () => {},
    reconnectBaseMs: 1000,
    reconnectMaxMs: 8000,
  });
  const reconnects = () => scheduled.map(item => item.ms).filter(ms => ms !== 250);
  assert.equal(updates.live(), false, 'sin stream abierto no se puede prometer el eco');
  updates.start('personal');
  sources[0].onopen();
  assert.equal(updates.live(), true);
  sources[0].readyState = 2;
  sources[0].onerror();
  assert.equal(updates.live(), false, 'un stream caído no puede sustituir la recarga');
  assert.deepEqual(reconnects(), [1000]);
  scheduled.find(item => item.ms === 1000).cb();
  assert.equal(sources.length, 2);
  sources[1].readyState = 2;
  sources[1].onerror();
  assert.deepEqual(reconnects(), [1000, 2000], 'el segundo intento espera el doble');
  updates.destroy();
});
