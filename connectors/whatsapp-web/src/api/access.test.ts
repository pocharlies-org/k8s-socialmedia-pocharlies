import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createConnectorAccess } from './access';
import { generateHMACSignature } from './auth';

const secret = 'test-connector-secret';
const basic = `Basic ${Buffer.from('operator:test-password').toString('base64')}`;

test('connector access protects pairing and history without giving UI sending privileges', async () => {
  const app = express();
  app.use(express.json());
  app.use(createConnectorAccess(secret, { username: 'operator', password: 'test-password' }));
  app.all('*', (_req, res) => res.json({ private: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ['/qr', '/qr/page', '/status', '/api/public/chats', '/api/public/history/chat', '/api/v1/auth/qr', '/api/v1/history/chat']) {
      assert.equal((await fetch(base + path)).status, 401, path);
    }
    for (const path of ['/qr', '/qr/page', '/status', '/api/v1/auth/qr']) {
      assert.equal((await fetch(base + path, { headers: { authorization: basic } })).status, 200, path);
    }
    assert.equal((await fetch(base + '/qr/renew', { method: 'POST', headers: { authorization: basic } })).status, 200);
    for (const path of ['/api/v1/messages/send', '/api/v1/history/sync', '/api/public/backfill-media']) {
      assert.equal((await fetch(base + path, { method: 'POST', headers: { authorization: basic } })).status, 401, path);
    }
    assert.deepEqual(await (await fetch(base + '/api/v1/health')).json(), { status: 'alive' });
    assert.deepEqual(await (await fetch(base + '/api/v1/health', { headers: { authorization: basic } })).json(), { private: true });
    const timestamp = Math.floor(Date.now() / 1000);
    assert.equal((await fetch(base + '/api/v1/messages/send', { method: 'POST', body: '{}', headers: {
      'content-type': 'application/json', 'x-connector-timestamp': String(timestamp),
      'x-connector-signature': generateHMACSignature({}, timestamp, secret),
    } })).status, 200);
    assert.equal((await fetch(base + '/qr', { headers: { authorization: 'Basic broken' } })).status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('missing configuration fails closed', async () => {
  const app = express();
  app.use(createConnectorAccess('', { username: '', password: '' }, ''));
  app.all('*', (_req, res) => res.json({ private: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/qr`, { headers: { authorization: basic } });
    assert.equal(response.status, 401);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
