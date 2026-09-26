import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const auth = `Basic ${Buffer.from('operator:password').toString('base64')}`;

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function databaseFor(conversations) {
  return {
    query: async (sql, args = []) => {
      if (/SELECT c\.id,/.test(sql)) {
        return {
          rows: conversations.filter(row => row.account === args[0]).map(row => ({
            ...row,
            waChatId: row.wa_chat_id,
            avatarUrl: row.avatar_url,
          })),
        };
      }
      if (/FROM conversations/.test(sql)) {
        return { rows: conversations.filter(row => row.account === args[0] && row.id === args[1]) };
      }
      return { rows: [] };
    },
  };
}

async function fixture(t, { env = {}, fetchImpl, conversations } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'whatsapp-avatar-cache-test-'));
  const runtimeEnv = {
    DATA_DIR: dir,
    UI_AUTH_USERNAME: 'operator',
    UI_AUTH_PASSWORD: 'password',
    APP_PUBLIC_URL: 'https://wa.example',
    PERSONAL_SECRET: 'personal-secret',
    SECONDARY_SECRET: 'secondary-secret',
    ...env,
  };
  const app = await createApp({
    env: runtimeEnv,
    db: databaseFor(conversations || [
      { account: 'personal', id: 'same-chat', wa_chat_id: 'same-wa', avatar_url: null },
      { account: 'secondary', id: 'same-chat', wa_chat_id: 'same-wa', avatar_url: null },
    ]),
    registry: [
      { channel: 'whatsapp', accountId: 'personal', secretEnv: 'PERSONAL_SECRET', connectorUrl: 'http://personal-connector' },
      { channel: 'whatsapp', accountId: 'secondary', secretEnv: 'SECONDARY_SECRET', connectorUrl: 'http://secondary-connector' },
    ],
    fetchImpl,
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = path => fetch(base + path, { headers: { authorization: auth } });
  return { request };
}

test('chat lists expose a proxy URL when the provider is the only photo source', async t => {
  const calls = [];
  const { request } = await fixture(t, {
    fetchImpl: async url => {
      calls.push(url);
      return Response.json({ data: Buffer.from('provider-photo').toString('base64'), contentType: 'image/jpeg' });
    },
  });
  const list = await request('/api/chats?account=personal');
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.match(body.chats[0].avatarUrl, /^\/api\/chats\/same-chat\/avatar\?account=personal$/);
  const avatar = await request(body.chats[0].avatarUrl);
  assert.equal(avatar.status, 200);
  assert.equal(calls.length, 1);
});

test('avatar requests coalesce per account/chat and keep same chat IDs isolated', async t => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { request } = await fixture(t, {
    fetchImpl: async url => {
      calls.push(url);
      await gate;
      return Response.json({ data: Buffer.from('avatar').toString('base64'), contentType: 'image/png' });
    },
  });

  const requests = [
    ...Array.from({ length: 8 }, () => request('/api/chats/same-chat/avatar?account=personal')),
    ...Array.from({ length: 8 }, () => request('/api/chats/same-chat/avatar?account=secondary')),
  ];
  await waitFor(() => calls.length === 2, 'provider requests did not start');
  assert.equal(calls.length, 2, 'one provider request should be in flight per account');
  assert.deepEqual(calls.map(url => new URL(url).host).sort(), ['personal-connector', 'secondary-connector']);
  release();
  const responses = await Promise.all(requests);
  assert.ok(responses.every(response => response.status === 200));
  assert.ok((await responses[0].arrayBuffer()).byteLength > 0);
  await Promise.all([
    request('/api/chats/same-chat/avatar?account=personal'),
    request('/api/chats/same-chat/avatar?account=secondary'),
  ]);
  assert.equal(calls.length, 2, 'successful responses should be served from the short cache');
});

test('unavailable avatars use a short negative cache and retry after its TTL', async t => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { request } = await fixture(t, {
    // Keep the negative entry alive while the concurrent HTTP responses drain;
    // the expiry assertion below still verifies a short-lived cache.
    env: { APP_AVATAR_NEGATIVE_CACHE_TTL_MS: '100' },
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return Response.json({ error: 'private photo' }, { status: 404 });
    },
  });
  const firstPromise = Promise.all(Array.from({ length: 6 }, () => request('/api/chats/same-chat/avatar?account=personal')));
  await waitFor(() => calls === 1, 'negative-cache provider request did not start');
  release();
  const first = await firstPromise;
  assert.ok(first.every(response => response.status === 404));
  assert.equal(calls, 1);
  assert.equal((await request('/api/chats/same-chat/avatar?account=personal')).status, 404);
  assert.equal(calls, 1);
  await new Promise(resolve => setTimeout(resolve, 125));
  assert.equal((await request('/api/chats/same-chat/avatar?account=personal')).status, 404);
  assert.equal(calls, 2, 'expired negative entries should allow a fresh provider lookup');
});

test('avatar source changes bypass a cached photo', async t => {
  const calls = [];
  const conversations = [{ account: 'personal', id: 'same-chat', wa_chat_id: 'first-wa', avatar_url: null }];
  const db = databaseFor(conversations);
  const dir = await mkdtemp(join(tmpdir(), 'whatsapp-avatar-cache-source-test-'));
  const app = await createApp({
    env: { DATA_DIR: dir, UI_AUTH_USERNAME: 'operator', UI_AUTH_PASSWORD: 'password', APP_PUBLIC_URL: 'https://wa.example', PERSONAL_SECRET: 'personal-secret' },
    db,
    registry: [{ channel: 'whatsapp', accountId: 'personal', secretEnv: 'PERSONAL_SECRET', connectorUrl: 'http://personal-connector' }],
    fetchImpl: async url => { calls.push(url); return Response.json({ data: Buffer.from(new URL(url).pathname).toString('base64') }); },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = () => fetch(`${base}/api/chats/same-chat/avatar?account=personal`, { headers: { authorization: auth } });
  assert.equal((await request()).status, 200);
  conversations[0].wa_chat_id = 'second-wa';
  assert.equal((await request()).status, 200);
  assert.equal(calls.length, 2, 'a provider chat change must invalidate the old source entry');
});
