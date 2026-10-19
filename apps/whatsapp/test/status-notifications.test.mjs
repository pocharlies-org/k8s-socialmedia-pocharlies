import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusNotificationMonitor } from '../public/status-notifications.mjs';

const author = (id, timestamp, { unseen = 1, own = false, name = '', latestStatusId = '', latestReceivedAt = '' } = {}) => ({
  id, latestTimestamp: timestamp, latestStatusId, latestReceivedAt, unseen, own, name,
});

function harness() {
  let account = 'personal';
  let permission = 'granted';
  let authors = [];
  const delivered = [];
  const listeners = new Map();
  const timers = new Set();
  const documentRef = {
    hidden: false,
    addEventListener: (event, callback) => listeners.set(event, callback),
    removeEventListener: event => listeners.delete(event),
  };
  const monitor = createStatusNotificationMonitor({
    documentRef,
    getAccount: () => account,
    permission: () => permission,
    loadAuthors: async requested => ({ account: requested, authors }),
    onStatus: event => delivered.push(event),
    setIntervalRef: callback => { timers.add(callback); return callback; },
    clearIntervalRef: callback => timers.delete(callback),
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    documentRef, delivered, listeners, timers, monitor, flush,
    setAccount: value => { account = value; },
    setPermission: value => { permission = value; },
    setAuthors: value => { authors = value; },
  };
}

test('a first snapshot is silent; hidden new unseen statuses notify once per author', async () => {
  const h = harness();
  h.setAuthors([author('111@s.whatsapp.net', '2026-09-29T10:00:00Z', { name: 'Ana' })]);
  h.monitor.start('personal');
  await h.flush();
  assert.deepEqual(h.delivered, []);

  h.documentRef.hidden = true;
  h.setAuthors([
    author('111@s.whatsapp.net', '2026-09-29T10:01:00Z', { name: 'Ana' }),
    author('222@s.whatsapp.net', '2026-09-29T10:01:00Z', { own: true }),
    author('333@s.whatsapp.net', '2026-09-29T10:01:00Z', { unseen: 0 }),
  ]);
  await h.monitor.check();
  assert.deepEqual(h.delivered.map(({ account, author: id, name }) => [account, id, name]), [['personal', '111@s.whatsapp.net', 'Ana']]);
  await h.monitor.check();
  assert.equal(h.delivered.length, 1);
  h.monitor.destroy();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
});

test('account changes and failed reads cannot deliver stale or cross-account alerts', async () => {
  const h = harness();
  h.setAuthors([author('111@s.whatsapp.net', '2026-09-29T10:00:00Z')]);
  h.monitor.start('personal');
  await h.flush();
  h.documentRef.hidden = true;
  h.setPermission('denied');
  h.setAuthors([author('111@s.whatsapp.net', '2026-09-29T10:01:00Z')]);
  await h.monitor.check();
  assert.deepEqual(h.delivered, []);

  h.setPermission('granted');
  h.setAccount('secondary');
  h.monitor.start('secondary');
  await h.flush();
  assert.deepEqual(h.delivered, [], 'the new account gets a silent first snapshot');
  h.setAuthors([author('111@s.whatsapp.net', '2026-09-29T10:02:00Z')]);
  await h.monitor.check();
  assert.deepEqual(h.delivered.map(item => item.account), ['secondary']);
  h.monitor.destroy();
});

test('a late response from the old account cannot seed or notify the new account', async () => {
  let releaseOld;
  let account = 'personal';
  const delivered = [];
  const monitor = createStatusNotificationMonitor({
    documentRef: { hidden: true, addEventListener() {}, removeEventListener() {} },
    getAccount: () => account,
    permission: () => 'granted',
    loadAuthors: requested => requested === 'personal'
      ? new Promise(resolve => { releaseOld = resolve; })
      : Promise.resolve({ account: 'secondary', authors: [author('222@s.whatsapp.net', '2026-09-29T10:00:00Z')] }),
    onStatus: event => delivered.push(event),
    setIntervalRef: () => 1,
    clearIntervalRef() {},
  });
  monitor.start('personal');
  account = 'secondary';
  monitor.start('secondary');
  await monitor.check();
  releaseOld({ account: 'personal', authors: [author('111@s.whatsapp.net', '2026-09-29T10:01:00Z')] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delivered, []);
  monitor.destroy();
});

test('pagehide cancels a hidden-tab check before Safari aborts its request', async () => {
  const handlers = new Map();
  const windowHandlers = new Map();
  const scheduled = new Map();
  let nextTimer = 0;
  let reads = 0;
  const documentRef = {
    hidden: false,
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: name => handlers.delete(name),
  };
  const windowRef = {
    addEventListener: (name, handler) => windowHandlers.set(name, handler),
    removeEventListener: name => windowHandlers.delete(name),
  };
  const monitor = createStatusNotificationMonitor({
    documentRef, windowRef,
    getAccount: () => 'personal', permission: () => 'granted',
    loadAuthors: async () => { reads += 1; return { account: 'personal', authors: [] }; },
    onStatus() {},
    setIntervalRef: () => 1, clearIntervalRef() {},
    setTimeoutRef: callback => { const id = ++nextTimer; scheduled.set(id, callback); return id; },
    clearTimeoutRef: id => scheduled.delete(id),
  });
  monitor.start('personal');
  await new Promise(resolve => setImmediate(resolve));
  documentRef.hidden = true;
  handlers.get('visibilitychange')();
  assert.equal(scheduled.size, 1);
  windowHandlers.get('pagehide')();
  assert.equal(scheduled.size, 0);
  assert.equal(reads, 1, 'navigation must not launch another status request');
  monitor.destroy();
  assert.equal(windowHandlers.size, 0);
});

test('a new unseen status with the same provider timestamp notifies once', async () => {
  const h = harness();
  const timestamp = '2026-09-29T10:00:00Z';
  h.setAuthors([author('111@s.whatsapp.net', timestamp, { latestStatusId: 'Z', latestReceivedAt: '2026-09-29T10:00:01.000001Z' })]);
  h.monitor.start('personal');
  await h.flush();
  h.documentRef.hidden = true;
  h.setAuthors([author('111@s.whatsapp.net', timestamp, { latestStatusId: 'A', latestReceivedAt: '2026-09-29T10:00:01.000002Z', unseen: 2 })]);
  await h.monitor.check();
  await h.monitor.check();
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].author, '111@s.whatsapp.net');
  h.monitor.destroy();
});
