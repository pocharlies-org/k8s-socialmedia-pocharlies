import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
import { webhookAuthorization } from './webhook-access';
import type { ConfiguredAccount } from './account-access';

test('webhook verifies exact raw bytes and rejects unknown or conflicting account recipients', async () => {
  const entry = (name: string, appSecret: string): ConfiguredAccount => ({ name, secret: name, ready: true, config: { accessToken: 'external', businessAccountId: name, appId: '', appSecret } });
  const accounts = new Map([['a', entry('a', 'app-a')], ['b', entry('b', 'app-b')], ['unconfigured', entry('unconfigured', '')]]);
  const app = express();
  app.use(express.json({ verify(req, _res, body) { (req as any).rawBody = body; } }));
  app.use('/webhook', webhookAuthorization(accounts, new Map([['id-a', 'a'], ['id-b', 'b'], ['id-empty', 'unconfigured']]), 'verify-token'));
  let accepted = 0;
  app.post('/webhook', (_req, res) => { accepted++; res.sendStatus(200); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/webhook`;
  const sign = (body: string, key = 'app-a') => 'sha256=' + createHmac('sha256', key).update(body).digest('hex');
  const post = (body: string, signature = sign(body)) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body });
  try {
    const raw = '{ "object": "instagram", "entry": [{ "id": "id-a" }] }';
    assert.equal((await post(raw)).status, 200);
    assert.equal((await post(raw, sign(JSON.stringify(JSON.parse(raw))))).status, 401, 'must sign original bytes, not parsed JSON');
    assert.equal((await post(raw, sign(raw, 'app-b'))).status, 401);
    assert.equal((await post(raw, '')).status, 401);
    assert.equal((await post(JSON.stringify({ object: 'instagram', entry: [{ id: 'unknown' }] }))).status, 403);
    assert.equal((await post(JSON.stringify({ object: 'instagram', entry: [{ id: 'id-a', messaging: [{ recipient: { id: 'id-b' } }] }] }))).status, 403);
    assert.equal((await post(JSON.stringify({ object: 'instagram', entry: [{ id: 'id-empty' }] }))).status, 503);
    assert.equal(accepted, 1, 'rejected payloads never reach event processing');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
