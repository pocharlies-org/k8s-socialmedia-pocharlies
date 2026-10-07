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
