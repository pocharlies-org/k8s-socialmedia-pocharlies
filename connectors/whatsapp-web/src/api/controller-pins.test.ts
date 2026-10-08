import '../test-env';
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createRouter } from './controller';
import { generateHMACSignature } from './auth';

test('pin history requires HMAC and a string conversationId, independently of sending', async () => {
  const secret = 'pin-fixture';
  const calls: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createRouter(
      {
        listPinnedMessages: async (chat: string) => {
          calls.push(chat);
          return { conversationId: chat, pinned: [], limit: 100, persisted: true };
        },
      } as any,
      { getCurrentQR: () => null } as any,
      secret
    )
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/messages/pins`;
  const previous = process.env.ENABLE_SENDING;
  process.env.ENABLE_SENDING = 'false';
  const post = (body: unknown, signed = true) => {
    const timestamp = Math.floor(Date.now() / 1000);
    return fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        ...(signed
          ? {
              'x-connector-timestamp': String(timestamp),
              'x-connector-signature': generateHMACSignature(body, timestamp, secret),
            }
          : {}),
      },
    });
  };
  try {
    assert.equal((await post({ conversationId: '123@g.us' }, false)).status, 401);
    for (const conversationId of ['', [], ['123@g.us'], 7, {}]) {
      assert.equal((await post({ conversationId })).status, 400);
    }
    assert.deepEqual(calls, []);
    const response = await post({ conversationId: '123-456@g.us' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      conversationId: '123-456@g.us',
      pinned: [],
      limit: 100,
      persisted: true,
    });
    assert.deepEqual(calls, ['123-456@g.us']);
  } finally {
    if (previous === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previous;
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
});
