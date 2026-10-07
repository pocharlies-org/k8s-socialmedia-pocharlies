import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const auth = `Basic ${Buffer.from('operator:password').toString('base64')}`;

function fakeBus() {
  const subscriptions = new Set();
  let closed = false;
  let connected = true;
  return {
    enabled: true,
    start() {},
    subscribe(account, listener) {
      const sub = { account, listener };
      subscriptions.add(sub);
      return () => subscriptions.delete(sub);
    },
    state: () => ({ connected }),
    disconnect() { connected = false; },
    publish(event) {
      for (const sub of subscriptions) {
        if (event.account && event.account !== sub.account) continue;
        sub.listener(event);
      }
    },
    get subscribers() { return subscriptions.size; },
    async close() { closed = true; subscriptions.clear(); },
    get closed() { return closed; },
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'whatsapp-events-test-'));
  const realtime = fakeBus();
  const db = { query: async () => ({ rows: [] }) };
  const env = {
    DATA_DIR: dir,
    UI_AUTH_USERNAME: 'operator',
    UI_AUTH_PASSWORD: 'password',
    APP_PUBLIC_URL: 'https://wa.example',
    APP_ENABLE_SENDING: 'false',
    APP_REALTIME_HEARTBEAT_MS: '100',
  };
  const app = await createApp({
    env,
    db,
    realtime,
    registry: [
      { channel: 'whatsapp', accountId: 'personal', secretEnv: 'PERSONAL_SECRET', connectorUrl: 'http://connector-personal' },
      { channel: 'whatsapp', accountId: 'secondary', secretEnv: 'SECONDARY_SECRET', connectorUrl: 'http://connector-secondary' },
    ],
    fetchImpl: async () => { throw Error('No upstream expected'); },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  t.after(async () => {
    if (!closed) await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    realtime,
    close: async () => { if (!closed) { closed = true; await app.close(); } },
    request: (path, headers = {}) => fetch(base + path, { headers }),
  };
}

async function nextFrame(reader, pending = '') {
  let buffer = pending;
  const decoder = new TextDecoder();
  while (!buffer.includes('\n\n')) {
    const { value, done } = await reader.read();
    assert.equal(done, false, 'SSE closed before its next frame');
    buffer += decoder.decode(value, { stream: true });
  }
  const end = buffer.indexOf('\n\n');
  return { frame: buffer.slice(0, end), rest: buffer.slice(end + 2) };
}

test('GET /api/events requires a session and a configured account', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/events?account=personal')).status, 401);
  assert.equal((await request('/api/events?account=missing', { authorization: auth })).status, 404);
});

test('SSE route emits account-scoped ID-only message/chat/resync hints', async t => {
  const { request, realtime } = await fixture(t);
  const response = await request('/api/events?account=personal', { authorization: auth });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(realtime.subscribers, 1);

  const reader = response.body.getReader();
  const first = await nextFrame(reader);
  assert.match(first.frame, /event: resync/);
  assert.match(first.frame, /"account":"personal"/);
  const message = {
    kind: 'message',
    account: 'personal',
    conversation_id: '346000@lid',
    message_id: 'db-id-1',
    wa_message_id: 'wa-id-1',
    reason: 'insert',
    content: 'private text must not escape',
  };
  realtime.publish({ ...message, account: 'secondary' });
  realtime.publish(message);
  const second = await nextFrame(reader, first.rest);
  assert.match(second.frame, /event: message/);
  assert.match(second.frame, /"conversation_id":"346000@lid"/);
  assert.match(second.frame, /"wa_message_id":"wa-id-1"/);
  assert.doesNotMatch(second.frame, /private text|content/);

  realtime.publish({ ...message, reason: 'reaction-to-own-message', emoji: 'private', reactor_jid: 'private' });
  const reaction = await nextFrame(reader, second.rest);
  assert.match(reaction.frame, /"reason":"reaction-to-own-message"/);
  assert.doesNotMatch(reaction.frame, /emoji|reactor_jid|private/);

  realtime.publish({ kind: 'chat', account: 'personal', conversation_id: 'chat@g.us' });
  const third = await nextFrame(reader, reaction.rest);
  assert.match(third.frame, /event: chat/);
  assert.match(third.frame, /"account":"personal"/);

  realtime.publish({ kind: 'resync', account: null, reason: 'reconnect' });
  const fourth = await nextFrame(reader, third.rest);
  assert.match(fourth.frame, /event: resync/);
  assert.match(fourth.frame, /"account":"personal"/);
  await reader.cancel();
});

test('close ends open SSE responses, releases subscriptions and closes the bus', async t => {
  const { request, realtime, close } = await fixture(t);
  const response = await request('/api/events?account=secondary', { authorization: auth });
  const reader = response.body.getReader();
  const initial = await nextFrame(reader);
  assert.match(initial.frame, /event: resync/);
  assert.equal(realtime.subscribers, 1);

  await close();
  const ended = await reader.read();
  assert.equal(ended.done, true);
  assert.equal(realtime.subscribers, 0);
  assert.equal(realtime.closed, true);
});

test('a lost LISTEN connection closes SSE so the browser can restore polling', async t => {
  const { request, realtime } = await fixture(t);
  const response = await request('/api/events?account=personal', { authorization: auth });
  const reader = response.body.getReader();
  await nextFrame(reader);
  realtime.disconnect();
  const ended = await Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(Error('SSE stayed open after LISTEN loss')), 1000)),
  ]);
  assert.equal(ended.done, true);
  assert.equal(realtime.subscribers, 0);
});
