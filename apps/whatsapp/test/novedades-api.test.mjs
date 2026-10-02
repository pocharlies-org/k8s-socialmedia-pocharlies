import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

async function fixture(t, { dbQuery, connectorResponse, env: envOverrides = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'novedades-api-'));
  const calls = [];
  const env = {
    DATA_DIR: dir, APP_PUBLIC_URL: 'https://wa.example', UI_AUTH_USERNAME: 'owner', UI_AUTH_PASSWORD: 'fixture',
    PERSONAL_SECRET: 'first', SECONDARY_SECRET: 'second', ...envOverrides,
  };
  const app = await createApp({
    env,
    db: { query: dbQuery || (async () => ({ rows: [] })) },
    registry: ['personal', 'secondary'].map(accountId => ({ channel: 'whatsapp', accountId, secretEnv: `${accountId.toUpperCase()}_SECRET`, connectorUrl: `http://${accountId}` })),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const target = new URL(url);
      if (connectorResponse) return Response.json(connectorResponse(target));
      if (target.pathname.endsWith('/media')) return Response.json({ ok: true, account: target.hostname, data: { base64: Buffer.from('0123456789').toString('base64'), size: 10, mimeType: 'video/mp4', fileName: "clip'\r\n.mp4" } });
      return Response.json({ ok: true, account: target.hostname, channels: [], hasMore: false, nextCursor: null, coverage: {} });
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (path, headers = {}, method = 'GET', body) => fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from('owner:fixture').toString('base64')}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { request, calls, env };
}

test('status authors use names stored for their own account and exact identity', async t => {
  const authors = [
    { id: '34600000001@c.us', name: null, count: 1, unseen: 1 },
    { id: '111111111111@lid', name: null, count: 1, unseen: 1 },
    { id: '34600000002@s.whatsapp.net', name: 'Nombre recibido', count: 1, unseen: 1 },
  ];
  const queries = [];
  const { request } = await fixture(t, {
    connectorResponse: target => ({ ok: true, account: target.hostname, authors, hasMore: false, nextCursor: null, coverage: {} }),
    dbQuery: async (sql, params) => {
      queries.push({ sql, params });
      if (!sql.includes('FROM whatsapp_contacts')) return { rows: [] };
      return { rows: params[0] === 'personal'
        ? [{ jid: '34600000001@s.whatsapp.net', name: 'Ari ❤️', pushName: null, waChatId: null }]
        : [{ jid: '111111111111@lid', name: 'Otra cuenta', pushName: null, waChatId: null }] };
    },
  });
  const personal = await (await request('/api/novedades/status/authors?account=personal')).json();
  const secondary = await (await request('/api/novedades/status/authors?account=secondary')).json();
  assert.deepEqual(personal.authors.map(author => author.name), ['Ari ❤️', null, 'Nombre recibido']);
  assert.deepEqual(secondary.authors.map(author => author.name), [null, 'Otra cuenta', 'Nombre recibido']);
  assert(queries.every(({ params }) => params[0] === 'personal' || params[0] === 'secondary'));
  assert(queries.some(({ params }) => params[1].includes('34600000001@c.us')));
  assert(queries.some(({ params }) => params[1].includes('34600000001@s.whatsapp.net')));
});

test('Novedades routes require authentication and select the account connector before reads', async t => {
  const { request, calls } = await fixture(t);
  assert.equal((await request('/api/novedades/channels?account=secondary', { authorization: '' })).status, 401);
  assert.equal((await request('/api/novedades/channels?account=missing')).status, 404);
  assert.equal(calls.length, 0);
  for (const account of ['personal', 'secondary']) {
    const response = await request(`/api/novedades/channels?account=${account}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).account, account);
    assert.equal(calls.at(-1).url, `http://${account}/api/v1/novedades/channels`);
    assert.equal(calls.at(-1).options.method, 'GET');
  }
  assert.equal((await request('/api/novedades/channels?account=secondary&includeDeleted=true')).status, 400);
  assert.equal(calls.length, 2);
});

test('channel lookup is account-scoped and never forwards raw provider metadata', async t => {
  const { request, calls } = await fixture(t, {
    connectorResponse: target => ({
      ok: true,
      account: target.hostname,
      channel: {
        id: '123456789012345678@newsletter',
        name: 'Canal consultado',
        role: 'guest',
        subscribed: false,
        invite: 'secret-invite',
        rawMetadata: { mediaKey: 'secret-key' },
      },
    }),
  });
  const query = 'https://whatsapp.com/channel/InviteCode';
  const response = await request(`/api/novedades/channels/lookup?account=secondary&query=${encodeURIComponent(query)}`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.account, 'secondary');
  assert.equal(result.channel.id, '123456789012345678@newsletter');
  assert.equal(result.channel.subscribed, false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(calls.at(-1).url, `http://secondary/api/v1/novedades/channels/lookup?query=${encodeURIComponent(query)}`);
  assert.equal(calls.at(-1).options.method, 'GET');

  assert.equal((await request('/api/novedades/channels/lookup?account=missing&query=abc')).status, 404);
  assert.equal(calls.length, 1, 'unknown accounts never reach a connector');
});

test('channel follow/unfollow requires app auth, origin and sending gates, then validates provider confirmation', async t => {
  const { request, calls } = await fixture(t, {
    env: { APP_ENABLE_SENDING: 'true' },
    connectorResponse: target => {
      if (target.pathname.endsWith('/subscription')) {
        return {
          ok: true,
          account: target.hostname,
          action: 'follow',
          confirmed: true,
          channel: {
            id: '123456789012345678@newsletter',
            name: 'Canal seguido',
            role: 'subscriber',
            subscribed: true,
            invite: 'secret-invite',
          },
        };
      }
      return { ok: true, account: target.hostname };
    },
  });
  const path = '/api/novedades/channels/subscription';
  const body = { account: 'secondary', jid: '123456789012345678@newsletter', action: 'follow' };
  const jsonHeaders = { origin: 'https://wa.example', 'content-type': 'application/json' };
  assert.equal((await request(path, { 'content-type': 'application/json' }, 'POST', body)).status, 403);
  assert.equal(calls.length, 0, 'origin is checked before the connector');

  const confirmed = await request(path, jsonHeaders, 'POST', body);
  assert.equal(confirmed.status, 200);
  const result = await confirmed.json();
  assert.equal(result.confirmed, true);
  assert.equal(result.account, 'secondary');
  assert.equal(result.channel.subscribed, true);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(calls.at(-1).url, 'http://secondary/api/v1/novedades/channels/subscription');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), {
    jid: '123456789012345678@newsletter',
    action: 'follow',
  });

  for (const invalid of [
    { ...body, jid: '123@g.us' },
    { ...body, action: 'create' },
  ]) {
    assert.equal((await request(path, jsonHeaders, 'POST', invalid)).status, 400);
  }
  assert.equal(calls.length, 1, 'invalid writes never reach a connector');
});

test('channel subscription does not claim another account or an unconfirmed provider write', async t => {
  const { request, calls } = await fixture(t, {
    env: { APP_ENABLE_SENDING: 'true' },
    connectorResponse: () => ({
      ok: true,
      account: 'personal',
      action: 'follow',
      confirmed: true,
      channel: { id: '123456789012345678@newsletter', subscribed: true },
    }),
  });
  const response = await request(
    '/api/novedades/channels/subscription',
    { origin: 'https://wa.example', 'content-type': 'application/json' },
    'POST',
    { account: 'secondary', jid: '123456789012345678@newsletter', action: 'follow' }
  );
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.code, 'SUBSCRIPTION_UNCONFIRMED');
  assert.equal(result.outcomeUncertain, true);
  assert.equal(calls.length, 1, 'one operation reaches the selected connector');
});

test('channel subscription refuses a different channel identity and a disabled sending gate', async t => {
  const body = { account: 'secondary', jid: '123456789012345678@newsletter', action: 'follow' };
  const headers = { origin: 'https://wa.example', 'content-type': 'application/json' };
  const disabled = await fixture(t, { connectorResponse: () => ({ ok: true }) });
  assert.equal((await disabled.request('/api/novedades/channels/subscription', headers, 'POST', body)).status, 403);
  assert.equal(disabled.calls.length, 0);

  const wrongChannel = await fixture(t, {
    env: { APP_ENABLE_SENDING: 'true' },
    connectorResponse: target => ({
      ok: true, account: target.hostname, action: 'follow', confirmed: true,
      channel: { id: '999@newsletter', subscribed: true },
    }),
  });
  const response = await wrongChannel.request('/api/novedades/channels/subscription', headers, 'POST', body);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).outcomeUncertain, true);
  assert.equal(wrongChannel.calls.length, 1);
});

test('Novedades media supports video seeking and safe download headers through the authenticated route', async t => {
  const { request } = await fixture(t);
  const path = '/api/novedades/media?account=secondary&kind=channel&jid=123%40newsletter&messageId=fixture';
  const whole = await request(path);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(whole.headers.get('cache-control'), 'no-store');
  assert(whole.headers.get('content-disposition').includes('%27%0D%0A'));
  assert.equal(await whole.text(), '0123456789');
  for (const [range, expected, contentRange] of [['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-', '89', 'bytes 8-9/10'], ['bytes=8-100', '89', 'bytes 8-9/10']]) {
    const response = await request(path, { range });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(Number(response.headers.get('content-length')), expected.length);
    assert.equal(await response.text(), expected);
  }
  for (const range of ['bytes=10-', 'bytes=-0', 'bytes=5-2']) {
    const response = await request(path, { range });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
  }
  assert.equal((await request(path, { range: 'bytes=1-2,5-6' })).status, 400);
  const fallback = await request(path, { range: 'bytes=2-4', 'if-range': '"old-version"' });
  assert.equal(fallback.status, 200);
  assert.equal(await fallback.text(), '0123456789');
});
