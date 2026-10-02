import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const jid = '120363000000001@g.us';
const groupJid = '120363000000002@g.us';
const community = {
  id: jid, name: 'Test community', description: '', participantCount: 4, createdAt: 1700000000,
  capabilities: { editInfo: true, manageGroups: true, leave: true },
};

async function fixture(t, { upstream = () => ({ ok: true, communities: [community] }), sending = true, query = async () => ({ rows: [] }) } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wa-communities-test-'));
  const calls = [];
  const app = await createApp({
    env: { DATA_DIR: dir, UI_AUTH_USERNAME: 'tester', UI_AUTH_PASSWORD: 'fixture', APP_PUBLIC_URL: 'https://wa.example', APP_ENABLE_SENDING: String(sending), A_SECRET: 'test-a', B_SECRET: 'test-b' },
    db: { query },
    registry: [
      { channel: 'whatsapp', accountId: 'a', secretEnv: 'A_SECRET', connectorUrl: 'http://connector-a' },
      { channel: 'whatsapp', accountId: 'b', secretEnv: 'B_SECRET', connectorUrl: 'http://connector-b' },
    ],
    fetchImpl: async (url, options) => {
      const call = { url, options, body: options.body ? JSON.parse(options.body) : undefined };
      calls.push(call);
      const result = await upstream(call);
      return result instanceof Response ? result : Response.json(result);
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (path, body, extraHeaders = {}) => fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Basic ${Buffer.from('tester:fixture').toString('base64')}`, ...(body ? { origin: 'https://wa.example', 'content-type': 'application/json' } : {}), ...extraHeaders },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { request, calls };
}

test('community reads use the selected account and project only public fields', async t => {
  const { request, calls } = await fixture(t, { upstream: () => ({ ok: true, communities: [{ ...community, participants: ['private'], token: 'private', capabilities: { editInfo: 'true', leave: true } }] }) });
  const response = await request('/api/communities?account=b');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.account, 'b');
  assert.equal(result.communities[0].capabilities.editInfo, false);
  assert.equal(result.communities[0].capabilities.leave, true);
  assert.doesNotMatch(JSON.stringify(result), /private|participants|token/);
  assert.equal(calls[0].url, 'http://connector-b/api/v1/communities');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
});

test('unknown account and unauthenticated reads never reach connector', async t => {
  const { request, calls } = await fixture(t);
  assert.equal((await request('/api/communities?account=other')).status, 404);
  assert.equal((await request('/api/communities?account=a', undefined, { authorization: '' })).status, 401);
  assert.equal(calls.length, 0);
});

test('community list errors and malformed data are not presented as an empty list', async t => {
  for (const upstream of [() => ({ ok: true }), () => ({ ok: true, communities: [{}] }), () => ({ ok: false }), () => Response.json({ error: 'unavailable' }, { status: 503 })]) {
    const { request } = await fixture(t, { upstream });
    assert.equal((await request('/api/communities?account=a')).status, 502);
  }
});

test('community detail validates requested identity and omits raw group metadata', async t => {
  const { request } = await fixture(t, { upstream: () => ({ ok: true, community, linkedGroups: [{ id: groupJid, name: 'Group', participantCount: 3, createdAt: null, inviteCode: 'private' }] }) });
  const response = await request(`/api/communities/${encodeURIComponent(jid)}?account=a`);
  assert.equal(response.status, 200);
  assert.doesNotMatch(JSON.stringify(await response.json()), /inviteCode|private/);
  assert.equal((await request(`/api/communities/${encodeURIComponent(groupJid)}?account=a`)).status, 502);
  assert.equal((await request('/api/communities/123@s.whatsapp.net?account=a')).status, 400);
});

test('creation enforces origin and strips unsolicited payload properties', async t => {
  const { request, calls } = await fixture(t, { upstream: () => ({ ok: true, community }) });
  const body = { account: 'a', subject: ' New ', description: '', participants: ['unsolicited'] };
  assert.equal((await request('/api/communities', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal(calls.length, 0);
  const response = await request('/api/communities', body);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).confirmed, true);
  assert.deepEqual(calls[0].body, { subject: 'New', description: '' });
});

test('linked archived groups receive a resolved internal chat id only from the selected account', async t => {
  const queries = [];
  const { request } = await fixture(t, {
    upstream: () => ({ ok: true, community, linkedGroups: [{ id: groupJid, name: 'Archived group', chatId: 'hostile' }] }),
    query: async (sql, args) => {
      queries.push({ sql, args });
      return { rows: args[0] === 'b' ? [{ id: `b:${groupJid}`, wa_chat_id: groupJid }] : [] };
    },
  });
  const secondary = await (await request(`/api/communities/${encodeURIComponent(jid)}?account=b`)).json();
  assert.equal(secondary.linkedGroups[0].chatId, `b:${groupJid}`);
  const primary = await (await request(`/api/communities/${encodeURIComponent(jid)}?account=a`)).json();
  assert.equal(primary.linkedGroups[0].chatId, null);
  assert.match(queries[0].sql, /WHERE account=\$1 AND is_group=true/);
  assert.deepEqual(queries[0].args, ['b', [groupJid]]);
});

test('all community writes respect disabled sending while reads remain available', async t => {
  const { request, calls } = await fixture(t, { sending: false });
  assert.equal((await request('/api/communities', { account: 'a', subject: 'Test' })).status, 403);
  assert.equal((await request(`/api/communities/${encodeURIComponent(jid)}/action`, { account: 'a', action: 'leave' })).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await request('/api/communities?account=a')).status, 200);
});

test('action validates target and explicit provider acknowledgement', async t => {
  const { request, calls } = await fixture(t, { upstream: call => ({ ok: true, communityId: jid, action: call.body.action }) });
  const path = `/api/communities/${encodeURIComponent(jid)}/action`;
  assert.equal((await request(path, { account: 'a', action: 'link', groupJid: jid })).status, 400);
  assert.equal((await request(path, { account: 'a', action: 'delete' })).status, 400);
  assert.equal(calls.length, 0);
  const response = await request(path, { account: 'a', action: 'link', groupJid });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).confirmed, true);
  assert.deepEqual(calls[0].body, { action: 'link', groupJid });
  const unconfirmed = await fixture(t, { upstream: () => ({ ok: true }) });
  assert.equal((await unconfirmed.request(path, { account: 'a', action: 'leave' })).status, 502);
});

test('empty description clears it, but blank subject and oversized input are refused', async t => {
  const { request, calls } = await fixture(t, { upstream: call => ({ ok: true, communityId: jid, action: call.body.action }) });
  const path = `/api/communities/${encodeURIComponent(jid)}/action`;
  assert.equal((await request(path, { account: 'a', action: 'subject', subject: ' ' })).status, 400);
  assert.equal((await request(path, { account: 'a', action: 'description', description: 'x'.repeat(2049) })).status, 400);
  assert.equal((await request(path, { account: 'a', action: 'description', description: '' })).status, 200);
  assert.deepEqual(calls[0].body, { action: 'description', description: '' });
});
