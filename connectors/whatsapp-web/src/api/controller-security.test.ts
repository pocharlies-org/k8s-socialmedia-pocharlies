import assert from 'node:assert/strict';
import express from 'express';
import { test } from 'node:test';
import { createRouter } from './controller';
import { generateHMACSignature } from './auth';
import { ProfilePictureTimeoutError } from '../baileys-client';

const secret = 'controller-security-test-secret';

async function startApp(client: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client as any, { getCurrentQR: () => null } as any, secret));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function signedHeaders(body: unknown) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'content-type': 'application/json',
    'x-connector-timestamp': String(timestamp),
    'x-connector-signature': generateHMACSignature(body, timestamp, secret),
  };
}

test('emergency sending lock blocks forward and delete before provider mutation', async () => {
  const previousEnabled = process.env.ENABLE_SENDING;
  const previousEmergency = process.env.EMERGENCY_DISABLE_SENDING;
  process.env.ENABLE_SENDING = 'true';
  process.env.EMERGENCY_DISABLE_SENDING = 'true';
  let forwardCalls = 0;
  let deleteCalls = 0;
  let localDeleteCalls = 0;
  const app = await startApp({
    forwardMessage: async () => { forwardCalls += 1; },
    deleteMessage: async () => { deleteCalls += 1; },
    deleteMessageForMe: async () => { localDeleteCalls += 1; },
  });
  try {
    const forwardBody = { chatId: '34600@c.us', messageId: 'm1', toChatId: '34601@c.us' };
    const forward = await fetch(`${app.base}/api/v1/messages/forward`, {
      method: 'POST',
      headers: signedHeaders(forwardBody),
      body: JSON.stringify(forwardBody),
    });
    assert.equal(forward.status, 403);

    const remove = await fetch(`${app.base}/api/v1/messages/34600%40c.us/m1`, {
      method: 'DELETE',
      headers: signedHeaders({}),
    });
    assert.equal(remove.status, 403);
    const removeLocal = await fetch(`${app.base}/api/v1/messages/34600%40c.us/m1/for-me`, {
      method: 'DELETE', headers: signedHeaders({}),
    });
    assert.equal(removeLocal.status, 403);
    assert.equal(forwardCalls, 0);
    assert.equal(deleteCalls, 0);
    assert.equal(localDeleteCalls, 0);
  } finally {
    await app.close();
    if (previousEnabled === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previousEnabled;
    if (previousEmergency === undefined) delete process.env.EMERGENCY_DISABLE_SENDING;
    else process.env.EMERGENCY_DISABLE_SENDING = previousEmergency;
  }
});

test('account and unread JSON reads preserve authentication, payloads and errors', async () => {
  let failure: unknown;
  const calls: string[] = [];
  const me = { id: '34600@c.us', platform: 'whatsapp' };
  const chats = [{ id: '34601@c.us', unreadCount: 2 }];
  const app = await startApp({
    getMe: async () => { calls.push('me'); if (failure) throw failure; return me; },
    getUnreadChats: async () => { calls.push('unread'); if (failure) throw failure; return chats; },
  });
  try {
    for (const [path, payload] of [['/me', me], ['/chats/unread', { chats }]] as const) {
      assert.equal((await fetch(`${app.base}/api/v1${path}`)).status, 401);
      assert.deepEqual(calls, []);
      const response = await fetch(`${app.base}/api/v1${path}`, { headers: signedHeaders({}) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), payload);
      calls.length = 0;
      failure = new Error('provider unavailable');
      const failed = await fetch(`${app.base}/api/v1${path}`, { headers: signedHeaders({}) });
      assert.equal(failed.status, 500);
      assert.deepEqual(await failed.json(), { error: 'Error: provider unavailable' });
      calls.length = 0;
      failure = undefined;
    }
  } finally {
    await app.close();
  }
});

test('parameterized chat mutations validate input and enforce both sending locks', async () => {
  const previousEnabled = process.env.ENABLE_SENDING;
  const previousEmergency = process.env.EMERGENCY_DISABLE_SENDING;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const app = await startApp({
    isConnected: () => true,
    modifyCapabilityChat: async (...args: unknown[]) => {
      calls.push({ method: 'modify', args });
      return { applied: true };
    },
    setDisappearing: async (...args: unknown[]) => {
      calls.push({ method: 'disappearing', args });
      return { expiration: args[1] };
    },
    markAsRead: async (...args: unknown[]) => { calls.push({ method: 'read', args }); },
  });
  const post = (path: string, body: unknown, signedBody = body) => fetch(`${app.base}/api/v1${path}`, {
    method: 'POST', headers: signedHeaders(signedBody), body: JSON.stringify(body),
  });
  const chat = '34600123456@c.us';
  const modify = `/chats/${encodeURIComponent(chat)}/modify`;
  const disappearing = `/chats/${encodeURIComponent(chat)}/disappearing`;
  try {
    for (const [enabled, emergency] of [['false', 'false'], ['true', 'true']]) {
      process.env.ENABLE_SENDING = enabled;
      process.env.EMERGENCY_DISABLE_SENDING = emergency;
      assert.equal((await post(modify, {})).status, 400);
      assert.equal((await post(disappearing, {})).status, 400);
      assert.equal((await post(modify, { action: 'archive' })).status, 403);
      assert.equal((await post(modify, {
        action: 'star', value: true, messageIds: [{ id: 'S1', fromMe: true }],
      })).status, 403);
      assert.equal((await post(disappearing, { expiration: 86400 })).status, 403);
      assert.equal((await post(`/messages/read/${encodeURIComponent(chat)}`, {})).status, 403);
      assert.equal(calls.length, 0);
    }
    process.env.ENABLE_SENDING = 'true';
    process.env.EMERGENCY_DISABLE_SENDING = 'false';
    const star = { action: 'star', value: true, messageIds: [{ id: 'S1', fromMe: true }] };
    assert.equal((await post(modify, star, {})).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await post(modify, star)).status, 200);
    assert.equal((await post(modify, { ...star, action: 'unstar', value: false })).status, 200);
    assert.equal((await post(disappearing, { expiration: 86400 })).status, 200);
    assert.equal((await post(`/messages/read/${encodeURIComponent(chat)}`, {})).status, 200);
    assert.deepEqual(calls, [
      { method: 'modify', args: [chat, 'star', true, [{ id: 'S1', fromMe: true }]] },
      { method: 'modify', args: [chat, 'unstar', false, [{ id: 'S1', fromMe: true }]] },
      { method: 'disappearing', args: [chat, 86400, { actor: undefined }] },
      { method: 'read', args: [chat] },
    ]);
  } finally {
    await app.close();
    if (previousEnabled === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previousEnabled;
    if (previousEmergency === undefined) delete process.env.EMERGENCY_DISABLE_SENDING;
    else process.env.EMERGENCY_DISABLE_SENDING = previousEmergency;
  }
});

test('photo lookup timeout returns 504 rather than a false missing-photo 404', async () => {
  const app = await startApp({
    getProfilePictureBytes: async () => { throw new ProfilePictureTimeoutError(); },
  });
  try {
    const response = await fetch(`${app.base}/api/v1/chats/34600%40c.us/photo`, {
      headers: signedHeaders({}),
    });
    assert.equal(response.status, 504);
  } finally {
    await app.close();
  }
});

test('archive snapshot apply requires connector authentication', async () => {
  let calls = 0;
  const app = await startApp({
    syncArchiveSnapshot: async () => {
      calls++;
      return { version: 4, records: 10, chats: 3, archived: 1, created: 1 };
    },
  });
  try {
    const denied = await fetch(`${app.base}/api/v1/chats/archive-snapshot/apply`, { method: 'POST' });
    assert.notEqual(denied.status, 200);
    assert.equal(calls, 0);
    const allowed = await fetch(`${app.base}/api/v1/chats/archive-snapshot/apply`, {
      method: 'POST', headers: signedHeaders({}), body: '{}',
    });
    assert.equal(allowed.status, 200);
    assert.equal(calls, 1);
    assert.deepEqual(await allowed.json(), {
      ok: true, version: 4, records: 10, chats: 3, archived: 1, created: 1,
    });
  } finally {
    await app.close();
  }
});
