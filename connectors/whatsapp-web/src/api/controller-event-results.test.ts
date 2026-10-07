import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createRouter } from './controller';
import { generateHMACSignature } from './auth';

test('event results require signed requests, reject malformed scope and remain available without sending', async () => {
  const secret = 'event-result-fixture';
  const calls: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use(createRouter({getEventResults: async (chat: string, ids: string[]) => {
    calls.push({chat, ids});
    return [{eventMessageId: ids[0], available: false, reason: 'ENCRYPTION_KEY_UNAVAILABLE'}];
  }} as any, {getCurrentQR: () => null} as any, secret));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}/messages/event/results`;
  const previousEnabled = process.env.ENABLE_SENDING;
  process.env.ENABLE_SENDING = 'false';
  const post = (body: unknown, signed = true) => {
    const timestamp = Math.floor(Date.now() / 1000);
    return fetch(url, {method: 'POST', body: JSON.stringify(body), headers: {
      'content-type': 'application/json',
      ...(signed ? {'x-connector-timestamp': String(timestamp), 'x-connector-signature': generateHMACSignature(body, timestamp, secret)} : {}),
    }});
  };
  try {
    const body = {conversationId: '123@g.us', eventMessageIds: ['event-1']};
    assert.equal((await post(body, false)).status, 401);
    for (const invalid of [{...body, conversationId: ''}, {...body, eventMessageIds: []}, {...body, eventMessageIds: [7]}, {...body, eventMessageIds: [' ']}, {...body, eventMessageIds: Array(51).fill('event')}]) {
      assert.equal((await post(invalid)).status, 400);
    }
    assert.deepEqual(calls, []);
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {ok: true, events: [{eventMessageId: 'event-1', available: false, reason: 'ENCRYPTION_KEY_UNAVAILABLE'}]});
    assert.deepEqual(calls, [{chat: '123@g.us', ids: ['event-1']}]);
  } finally {
    if (previousEnabled === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previousEnabled;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
