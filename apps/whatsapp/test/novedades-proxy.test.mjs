import test from 'node:test';
import assert from 'node:assert/strict';
import { novedadesRequest, readNovedades } from '../lib/novedades-proxy.mjs';

const account = { accountId: 'secondary', connectorUrl: 'http://secondary' };
const params = value => new URLSearchParams(value);
const envelope = extra => ({ ok: true, account: 'secondary', hasMore: false, nextCursor: null, coverage: {}, ...extra });
async function read(path, query, body, status = 200, capture = () => {}) {
  return readNovedades({ account, path, params: params(query), secret: 'test-secret', remote: async (url, options) => {
    capture(url, options);
    return Response.json(body, { status });
  } });
}

test('catalog requests whitelist GET routes, pagination and author identity', () => {
  const req = novedadesRequest('/api/novedades/status', params('account=secondary&author=12345%40lid&limit=50&cursor=YWJj'));
  assert.equal(req.endpoint, '/novedades/status?author=12345%40lid&limit=50&cursor=YWJj');
  assert.equal(novedadesRequest('/api/novedades/channels/123%40newsletter/posts', params('account=secondary')).scope, '123@newsletter');
  for (const query of ['includeDeleted=true', 'visibility=event', 'limit=101', 'limit=0', 'limit=5&limit=10', 'cursor=../foo']) {
    assert.throws(() => novedadesRequest('/api/novedades/channels', params(query)), { status: 400 });
  }
  assert.throws(() => novedadesRequest('/api/novedades/status', params('author=123@g.us')), { status: 400 });
  assert.throws(() => novedadesRequest('/api/novedades/channels/123%40g.us/posts', params('')), { status: 400 });
  assert.throws(() => novedadesRequest('/api/novedades/channels/123%ZZ/posts', params('')), { status: 400 });
  assert.throws(() => novedadesRequest('/api/novedades/delete', params('')), { status: 404 });
});

test('account attribution is mandatory and errors retain HTTP status without leaking provider details', async () => {
  const path = '/api/novedades/channels';
  for (const body of [envelope({ account: 'personal', channels: [] }), envelope({ account: undefined, channels: [] }), { ok: false }]) {
    await assert.rejects(read(path, '', body), { status: 502 });
  }
  await assert.rejects(read(path, '', { ok: false, error: { code: 'NOVEDADES_NOT_FOUND', message: 'secret provider url' } }, 404), error => {
    assert.equal(error.status, 404); assert.equal(error.code, 'NOVEDADES_NOT_FOUND');
    assert(!error.message.includes('secret')); return true;
  });
  await assert.rejects(read(path, '', {ok:false,account:'personal',error:{code:'NOVEDADES_NOT_FOUND'}},404),{status:404,code:'NOVEDADES_NOT_FOUND'});
  for (const status of [503,504]) {
    await assert.rejects(readNovedades({account,path,params:params(''),secret:'fixture',
      remote:async()=>new Response('<html>private upstream details</html>',{status}),
    }),error=>{
      assert.equal(error.status,status);assert.equal(error.code,'NOVEDADES_UNAVAILABLE');
      assert(!error.message.includes('private'));return true;
    });
  }
});

test('status media URLs are rebuilt with exact account/author/message scope', async () => {
  const id = 'message+1';
  const result = await read('/api/novedades/status', 'account=secondary&author=12345%40lid', envelope({ items: [{
    id, author: '12345@lid', kind: 'image', text: 'caption', active: true,
    timestamp: '2026-09-27T10:00:00Z', expiresAt: '2026-09-28T10:00:00Z', remainingMs: 1000,
    mediaUrl: 'https://provider.invalid/private?key=secret', mediaKey: 'secret', rawPayload: { token: 'secret' },
  }] }), 200, (url, options) => {
    assert(url.startsWith('http://secondary/api/v1/novedades/status?'));
    assert.equal(options.method, 'GET'); assert(!options.body); assert(options.headers['x-connector-signature']);
  });
  const item = result.data.items[0];
  const url = new URL(item.mediaUrl, 'https://app.invalid');
  assert.equal(url.pathname, '/api/novedades/media');
  assert.equal(url.searchParams.get('account'), 'secondary');
  assert.equal(url.searchParams.get('jid'), '12345@lid');
  assert.equal(url.searchParams.get('messageId'), id);
  assert(!JSON.stringify(result).includes('secret'));
  assert.equal(item.timestamp, '2026-09-27T10:00:00.000Z');
  await assert.rejects(read('/api/novedades/status', 'author=12345%40lid', envelope({ items: [{ id: '1', author: '999@lid' }] })), { status: 502 });
});

test('channel metadata and pagination are projected without raw provider fields', async () => {
  const result = await read('/api/novedades/channels', '', envelope({ hasMore: true, nextCursor: 'YWJj', channels: [{
    id: '123@newsletter', name: 'Fixture', role: 'owner', subscribed: true, privateKey: 'secret', avatarUrl: 'https://provider.invalid',
  }] }));
  assert.equal(result.data.channels[0].subscribed, true);
  assert.equal(result.data.channels[0].avatarUrl, null);
  assert.equal(result.data.nextCursor, 'YWJj');
  await assert.rejects(read('/api/novedades/channels', '', envelope({ hasMore: true, nextCursor: null, channels: [] })), { status: 502 });
  await assert.rejects(read('/api/novedades/channels', '', envelope({ hasMore: true, nextCursor: 'a'.repeat(8193), channels: [] })), { status: 502 });
  await assert.rejects(read('/api/novedades/channels', '', envelope({ hasMore: true, nextCursor: 'bad cursor', channels: [] })), { status: 502 });
  await assert.rejects(read('/api/novedades/channels/123%40newsletter/posts', '', envelope({ channel: { id: '999@newsletter' }, items: [] })), { status: 502 });
});

test('channel lookup forwards only one query and projects a safe account-scoped result', async () => {
  const query = 'https://whatsapp.com/channel/InviteCode';
  const request = novedadesRequest('/api/novedades/channels/lookup', params(`account=secondary&query=${encodeURIComponent(query)}`));
  assert.equal(request.kind, 'lookup');
  assert.equal(request.endpoint, `/novedades/channels/lookup?query=${encodeURIComponent(query)}`);
  assert.throws(() => novedadesRequest('/api/novedades/channels/lookup', params('query=abc&other=x')), { status: 400 });
  assert.throws(() => novedadesRequest('/api/novedades/channels/lookup', params('query=&account=secondary')), { status: 400 });

  const result = await read(
    '/api/novedades/channels/lookup',
    `account=secondary&query=${encodeURIComponent(query)}`,
    envelope({
      channel: {
        id: '123@newsletter',
        name: 'Canal público',
        description: 'Descripción',
        role: 'guest',
        subscribed: false,
        verification: 'verified',
        subscribers: 15,
        createdAt: '2026-09-28T00:00:00.000Z',
        invite: 'secret-invite',
        rawMetadata: { mediaKey: 'secret-key' },
      },
    })
  );
  assert.equal(result.data.channel.id, '123@newsletter');
  assert.equal(result.data.channel.subscribed, false);
  assert.equal(JSON.stringify(result).includes('secret'), false);

  await assert.rejects(
    read('/api/novedades/channels/lookup', `account=secondary&query=${encodeURIComponent(query)}`, envelope({
      account: 'personal',
      channel: { id: '123@newsletter', name: 'Private from other account' },
    })),
    { status: 502 }
  );
});

test('channel avatars use only account-scoped media routes and never provider URLs', async () => {
  const result = await read('/api/novedades/channels', '', envelope({ channels: [{ id: '123@newsletter', avatarAvailable: true, avatarUrl: 'https://private.invalid' }] }));
  const url = new URL(result.data.channels[0].avatarUrl, 'https://app.invalid');
  assert.equal(url.searchParams.get('account'), 'secondary');
  assert.equal(url.searchParams.get('kind'), 'avatar');
  assert.equal(novedadesRequest(url.pathname, url.searchParams).endpoint, '/novedades/media?kind=avatar&jid=123%40newsletter');
  assert.throws(() => novedadesRequest('/api/novedades/media', params('kind=avatar&jid=123%40newsletter&messageId=unrelated')), { status: 400 });
  assert.throws(() => novedadesRequest('/api/novedades/media', params('kind=avatar&jid=123%40lid')), { status: 400 });
});

test('catalog identities reject arrays instead of coercing them into valid JIDs', async () => {
  await assert.rejects(read('/api/novedades/channels', '', envelope({ channels: [{ id: ['123@newsletter'] }] })), { status: 502 });
  await assert.rejects(read('/api/novedades/status/authors', '', envelope({ authors: [{ id: ['123@lid'] }] })), { status: 502 });
});

test('author status identity and its microsecond watermark survive the proxy untouched', async () => {
  const micro = '2026-09-28T10:00:00.000002Z';
  const result = await read('/api/novedades/status/authors', '', envelope({ authors: [{
    id: '12345@lid', name: 'Ana', own: false, count: 2, total: 2, unseen: 1,
    latestTimestamp: '2026-09-28T10:00:00Z', latestStatusId: 'ST-TIE-AAA', latestReceivedAt: micro,
    rawPayload: { token: 'secret' },
  }] }));
  const [author] = result.data.authors;
  assert.equal(author.latestStatusId, 'ST-TIE-AAA');
  assert.equal(author.latestReceivedAt, micro, 'a millisecond Date round-trip would lose the tie');
  assert.equal(JSON.stringify(result).includes('secret'), false);

  const legacy = await read('/api/novedades/status/authors', '', envelope({ authors: [{
    id: '12345@lid', count: 1, total: 1, unseen: 1, latestTimestamp: '2026-09-28T10:00:00Z',
  }] }));
  assert.equal(legacy.data.authors[0].latestStatusId, null, 'an older connector still serves authors');
  assert.equal(legacy.data.authors[0].latestReceivedAt, null);

  for (const bad of ['2026-09-28T10:00:00.000002+02:00', '2026-09-28 10:00:00.000002Z', '2026-09-28T10:00:00.002Z', 'yesterday', 1789840800, ['x'], '2026-09-28T10:00:00.0000000Z'])
    assert.equal((await read('/api/novedades/status/authors', '', envelope({ authors: [{ id: '12345@lid', latestReceivedAt: bad }] }))).data.authors[0].latestReceivedAt, null, `cannot order by ${JSON.stringify(bad)}`);
  assert.equal((await read('/api/novedades/status/authors', '', envelope({ authors: [{ id: '12345@lid', latestStatusId: ['ST-TIE-AAA'] }] }))).data.authors[0].latestStatusId, null);
});

test('media validates bytes and forces potentially executable formats to download', async () => {
  const query = 'kind=channel&jid=123%40newsletter&messageId=1';
  const data = { base64: Buffer.from('<svg/>').toString('base64'), size: 6, mimeType: 'image/svg+xml', fileName: 'image.svg' };
  const result = await read('/api/novedades/media', query, envelope({ data }));
  assert.equal(result.media.inline, false);
  assert.equal(result.media.mimeType, 'application/octet-stream');
  for (const broken of [{ ...data, size: 5 }, { ...data, base64: data.base64 + '\n' }, { ...data, base64: '?' }]) {
    await assert.rejects(read('/api/novedades/media', query, envelope({ data: broken })), { status: 502 });
  }
  const bytes = Buffer.alloc(1024 * 1024, 1);
  const large = await read('/api/novedades/media', query, envelope({ data: { base64: bytes.toString('base64'), size: bytes.length, mimeType: 'image/jpeg' } }));
  assert.equal(large.media.bytes.length, bytes.length);
  assert.equal(large.media.inline, true);
});

test('oversized connector responses are cancelled before unbounded buffering', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    }), { headers: declared ? { 'content-length': String(20 * 1024 * 1024) } : {} });
    await assert.rejects(readNovedades({ account, path: '/api/novedades/channels', params: params(''), secret: 'fixture', remote: async () => response }), { status: 502 });
    assert.equal(cancelled, true);
  }
});
