// Run inside the app container. This creates a loopback-only diagnostic server
// with a read-only PostgreSQL pool; it never opens chats or emits read receipts.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = resolve(process.argv[2] || '/app/server.mjs');
const require = createRequire(source);
const { Pool } = require('pg');
const { createApp } = await import(pathToFileURL(source));
const directory = await mkdtemp(join(tmpdir(), 'socialmedia-readcheck-'));
const password = randomUUID();
const pool = new Pool({ connectionString: process.env.DATABASE_URL,
  options: '-c default_transaction_read_only=on', statement_timeout: 15000 });
let app;
try {
  app = await createApp({ env: { ...process.env, APP_AUTH_MODE: 'basic',
    UI_AUTH_USERNAME: 'readcheck', UI_AUTH_PASSWORD: password, DATA_DIR: directory }, db: pool });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { authorization: `Basic ${Buffer.from(`readcheck:${password}`).toString('base64')}` };
  async function get(path, params = {}) {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url, { headers });
    const value = await response.json();
    assert.equal(response.status, 200, `${path}: HTTP ${response.status}, ${value.error || ''}`);
    return value;
  }
  const accounts = (await get('/api/accounts')).accounts;
  const results = [];
  for (const account of accounts) {
    const params = { account: account.id };
    const active = (await get('/api/chats', params)).chats;
    const archived = (await get('/api/chats', { ...params, archived: 'only' })).chats;
    assert.ok(active.every(chat => !chat.archived));
    assert.ok(archived.every(chat => chat.archived));
    assert.ok(!active.some(chat => archived.some(other => other.id === chat.id)));
    const chat = active[0] || archived[0];
    let messages = 0;
    let avatarStatus = null;
    if (chat) {
      const scoped = { ...params, chat: chat.id };
      messages = (await get('/api/messages', scoped)).messages.length;
      await get('/api/chats/media', scoped);
      await get('/api/search', { ...scoped, q: 'socialmedia-readcheck-no-match' });
      await get('/api/presence', scoped);
      const avatar = await fetch(new URL(chat.avatarUrl, base), { headers });
      avatarStatus = avatar.status;
      await avatar.arrayBuffer();
    }
    let groupChecked = false;
    const group = [...active, ...archived].find(chat => chat.isGroup);
    if (group) {
      const info = await get('/api/chat-details', { ...params, chat: group.id });
      assert.ok(Array.isArray(info.participants));
      assert.equal(typeof info.capabilities?.manageMembers, 'boolean');
      groupChecked = true;
    }
    const candidateIds = active.filter(item => !item.isGroup).map(item => item.id);
    const { rows: providerCandidates } = await pool.query(
      `SELECT id FROM conversations WHERE account=$1 AND id=ANY($2::text[])
       AND avatar_url IS NULL LIMIT 1`, [account.id, candidateIds]);
    let providerAvatarStatus = null;
    if (providerCandidates[0]) {
      const candidate = active.find(item => item.id === providerCandidates[0].id);
      const response = await fetch(new URL(candidate.avatarUrl, base), { headers });
      providerAvatarStatus = response.status;
      await response.arrayBuffer();
    }
    results.push({ active: active.length, archived: archived.length, messages, groupChecked, avatarStatus, providerAvatarStatus });
  }
  const ok = results.every(result => [result.avatarStatus, result.providerAvatarStatus]
    .every(status => status === null || [200, 404].includes(status)));
  console.log(JSON.stringify({ ok, accounts: results.length, results }));
  if (!ok) process.exitCode = 1;
} finally {
  await app?.close();
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
