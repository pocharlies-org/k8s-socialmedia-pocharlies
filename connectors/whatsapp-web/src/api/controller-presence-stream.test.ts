import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { createRouter } from './controller';
import { generateHMACSignature } from './auth';

const secret = 'presence-stream-test-secret';

test('authenticated presence stream forwards only its chat and releases its listener', async () => {
  const client = new EventEmitter() as EventEmitter & {
    getPresence: (chat: string) => Promise<{ chatId: string; status: string }>;
    subscribePresence: (chat: string) => Promise<{ subscribed: boolean }>;
  };
  client.getPresence = async chat => ({ chatId: chat, status: 'unknown' });
  let subscribed = '';
  client.subscribePresence = async chat => {
    subscribed = chat;
    return { subscribed: true };
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client as never, { getCurrentQR: () => null } as never, secret));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/chats/34600123456%40c.us/presence/stream`;
  const abort = new AbortController();
  try {
    assert.equal((await fetch(url)).status, 401);
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(url, {
      signal: abort.signal,
      headers: {
        'x-connector-timestamp': String(timestamp),
        'x-connector-signature': generateHMACSignature({}, timestamp, secret),
      },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /"status":"unknown"/);
    assert.equal(subscribed, '34600123456@c.us');
    client.emit('presence-update', { chatId: 'other@c.us', status: 'available' });
    client.emit('presence-update', { chatId: '34600123456@c.us', status: 'composing' });
    const update = new TextDecoder().decode((await reader.read()).value);
    assert.match(update, /"status":"composing"/);
    assert.doesNotMatch(update, /other@c\.us/);
    const released = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Presence listener was not released')),
        2000
      );
      client.once('removeListener', event => {
        clearTimeout(timeout);
        assert.equal(event, 'presence-update');
        resolve();
      });
    });
    abort.abort();
    await released;
    assert.equal(client.listenerCount('presence-update'), 0);
  } finally {
    abort.abort();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test(
  'disconnect during the initial presence lookup releases its listener',
  { timeout: 10_000 },
  async () => {
    const client = new EventEmitter() as EventEmitter & {
      getPresence: (chat: string) => Promise<{ chatId: string; status: string }>;
      subscribePresence: (chat: string) => Promise<{ subscribed: boolean }>;
    };
    let resolvePresence!: (value: { chatId: string; status: string }) => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>(resolve => {
      lookupStarted = resolve;
    });
    client.getPresence = () => {
      lookupStarted();
      return new Promise(resolve => {
        resolvePresence = resolve;
      });
    };
    client.subscribePresence = async () => ({ subscribed: true });
    let responseClosed!: () => void;
    const closed = new Promise<void>(resolve => {
      responseClosed = resolve;
    });
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.once('close', responseClosed);
      next();
    });
    app.use(
      '/api/v1',
      createRouter(client as never, { getCurrentQR: () => null } as never, secret)
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const timestamp = Math.floor(Date.now() / 1000);
    const abort = new AbortController();
    try {
      const response = fetch(
        `http://127.0.0.1:${address.port}/api/v1/chats/34600123456%40c.us/presence/stream`,
        {
          signal: abort.signal,
          headers: {
            'x-connector-timestamp': String(timestamp),
            'x-connector-signature': generateHMACSignature({}, timestamp, secret),
          },
        }
      );
      await started;
      abort.abort();
      await assert.rejects(response, { name: 'AbortError' });
      // Client-side abort settles before the server observes its socket closing.
      await closed;
      resolvePresence({ chatId: '34600123456@c.us', status: 'unknown' });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(client.listenerCount('presence-update'), 0);
    } finally {
      abort.abort();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
);
