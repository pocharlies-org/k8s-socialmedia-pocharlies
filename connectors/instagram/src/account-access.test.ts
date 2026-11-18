import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { loadConfiguredAccounts, accountAuthorization } from './account-access';
import { webhookAuthorization } from './webhook-access';
import { createHmac } from 'node:crypto';

test('registry requires explicit enabled accounts, retains missing credentials and isolates bearer access', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ig-auth-')), 'accounts.json');
  writeFileSync(file, JSON.stringify([{ channel: 'instagram', accountId: 'test-one', enabled: true, secretEnv: 'ONE' }, { channel: 'instagram', accountId: 'second', enabled: true, secretEnv: 'TWO' }]));
  const env = { SOCIAL_ACCOUNTS_FILE: file, INSTAGRAM_ACCOUNTS: 'test-one,second', ONE: 'one', TWO: 'two', INSTAGRAM_SECOND_ACCESS_TOKEN: 'external', INSTAGRAM_SECOND_BUSINESS_ACCOUNT_ID: 'biz', INSTAGRAM_SECOND_APP_SECRET: 'app' };
  const accounts = loadConfiguredAccounts(env);
  assert.equal(accounts.get('test-one')?.ready, false);
  assert.equal(accounts.get('second')?.ready, true);
  assert.throws(() => loadConfiguredAccounts({ ...env, INSTAGRAM_ACCOUNTS: 'unknown' }), /unknown or disabled/);
  const app = express();
  app.use(express.json({ verify(req, _res, body) { (req as any).rawBody = body; } }));
  app.use('/webhook', webhookAuthorization(accounts, new Map([['biz', 'second']]), 'verify'));
  app.post('/webhook', (_req, res) => res.sendStatus(200));
  app.use('/api/v1/:account', accountAuthorization(accounts));
  app.all('*', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path: string, token = '') => fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  try {
    assert.equal((await get('/api/v1/second/profile')).status, 401);
    assert.equal((await get('/api/v1/second/profile', 'one')).status, 401);
    assert.equal((await get('/api/v1/second/profile', 'two')).status, 200);
    assert.equal((await get('/api/v1/unknown/profile', 'one')).status, 404);
    assert.equal((await get('/api/v1/test-one/profile', 'one')).status, 503);
    assert.equal((await (await get('/api/v1/test-one/status', 'one')).json()).status, 'setup-required');
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: 'biz' }] });
    const post = (signature: string, content = body) => fetch(base + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: content });
    const sign = (content: string) => 'sha256=' + createHmac('sha256', 'app').update(content).digest('hex');
    assert.equal((await post('')).status, 401);
    assert.equal((await post(sign(body))).status, 200);
    const unknown = JSON.stringify({ object: 'instagram', entry: [{ id: 'unknown' }] });
    assert.equal((await post(sign(unknown), unknown)).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
