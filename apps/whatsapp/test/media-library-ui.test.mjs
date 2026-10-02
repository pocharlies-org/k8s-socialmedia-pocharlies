import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMediaLibraryClient,
  mediaAssetUrl,
  normalizeMediaLibraryItem,
  uniqueMediaMessages,
  webLinkUrl,
} from '../public/media-library-ui.mjs';

test('bulk actions operate once per message even with multiple attachments', () => {
  assert.deepEqual(uniqueMediaMessages([
    {chatId: 'one', messageId: 'same'},
    {chatId: 'one', messageId: 'same'},
    {chatId: 'two', messageId: 'same'},
    {chatId: 'one', messageId: ''},
  ]), [
    {chat: 'one', messageId: 'same'},
    {chat: 'two', messageId: 'same'},
  ]);
});

const BASE = 'https://wa.example.com/';
const ASSET = id => `/api/media/${id}?account=personal&chat=123%40s.whatsapp.net`;

const clientWith = (account, api) => createMediaLibraryClient({ getAccount: () => account, api, baseUrl: () => BASE });
const ok = (account, items = [], nextCursor = null) => ({ account, items, nextCursor });

test('the library request carries the contract parameters and only the active account', async () => {
  const calls = [];
  const client = clientWith('personal', async url => { calls.push(url); return ok('personal'); });
  await client.page({});
  await client.page({ kind: 'links', sender: 'others', order: 'oldest', q: '  factura  ', cursor: 'abc+' });
  const first = new URL(calls[0], BASE);
  assert.equal(first.pathname, '/api/media-library');
  assert.equal(first.searchParams.get('account'), 'personal');
  assert.equal(first.searchParams.get('kind'), 'media');
  assert.equal(first.searchParams.get('sender'), 'all');
  assert.equal(first.searchParams.get('order'), 'newest');
  assert.equal(first.searchParams.get('limit'), '50');
  assert.equal(first.searchParams.has('q'), false);
  assert.equal(first.searchParams.has('cursor'), false);
  const second = new URL(calls[1], BASE).searchParams;
  assert.deepEqual([second.get('kind'), second.get('sender'), second.get('order')], ['links', 'others', 'oldest']);
  assert.equal(second.get('q'), 'factura');
  assert.equal(second.get('cursor'), 'abc+');
});

test('late responses cannot answer for an invalidated generation or another account', async () => {
  let account = 'personal';
  let finish;
  const client = createMediaLibraryClient({
    getAccount: () => account,
    baseUrl: () => BASE,
    api: () => new Promise(resolve => { finish = resolve; }),
  });
  const first = client.page({});
  client.invalidate();
  finish(ok('personal'));
  assert.equal(await first, null);
  const second = client.page({});
  account = 'secondary';
  finish(ok('personal'));
  assert.equal(await second, null);
});

test('a page from another account or without an item list is rejected', async () => {
  for (const result of [ok('secondary'), { account: 'personal' }, { account: 'personal', items: 'x' }, null]) {
    const client = clientWith('personal', async () => result);
    await assert.rejects(client.page({}), /biblioteca multimedia no válida/);
  }
});

test('media assets only survive when they are our own authorized /api/media route', () => {
  assert.equal(mediaAssetUrl(ASSET('a1'), BASE, 'personal'), ASSET('a1'));
  assert.equal(mediaAssetUrl(`https://wa.example.com${ASSET('a2')}`, BASE, 'personal'), ASSET('a2'));
  assert.equal(mediaAssetUrl('https://mmgc1.whatsapp.net/photo.jpg?sig=secret', BASE, 'personal'), '');
  assert.equal(mediaAssetUrl('/api/media/a3?account=secondary', BASE, 'personal'), '');
  assert.equal(mediaAssetUrl('/api/media/thumb/a4?account=personal', BASE, 'personal'), '');
  assert.equal(mediaAssetUrl('/api/chats/media?kind=media', BASE, 'personal'), '');
  assert.equal(mediaAssetUrl('javascript:alert(1)', BASE, 'personal'), '');
  assert.equal(mediaAssetUrl('', BASE, 'personal'), '');
});

test('links stay absolute http/https and keep every distinct link of the message', () => {
  assert.equal(webLinkUrl('https://a.example/x, '), 'https://a.example/x');
  assert.equal(webLinkUrl('/relative'), '');
  assert.equal(webLinkUrl('javascript:alert(1)'), '');
  const item = normalizeMediaLibraryItem({
    id: 'm1', kind: 'link', chatId: '123@c.us', chatName: 'Ana', messageId: 'w1',
    timestamp: '2026-09-20T10:00:00Z', fromMe: false, url: 'https://a.example/x',
    links: [{ url: 'https://a.example/x', title: 'Primero' }, { url: 'https://b.example/y', title: '  Segundo ' },
      { url: 'https://a.example/x' }, { url: 'javascript:alert(1)' }, null],
  }, BASE, 'personal');
  assert.equal(item.url, 'https://a.example/x');
  assert.deepEqual(item.links, [{ url: 'https://a.example/x', title: 'Primero' }, { url: 'https://b.example/y', title: 'Segundo' }]);
});

test('items are sanitized and unusable rows are dropped instead of rendered', () => {
  const media = normalizeMediaLibraryItem({
    id: 'f1', kind: 'image', chatId: 'group-1@g.us', chatName: '  ', messageId: 'w2',
    timestamp: 'not-a-date', fromMe: true, name: 'foto.jpg', mimeType: 'image/jpeg',
    url: 'https://mmgc1.whatsapp.net/photo.jpg?sig=secret',
  }, BASE, 'personal');
  assert.deepEqual([media.url, media.chatName, media.timestamp], ['', 'group-1@g.us', '']);
  const available = normalizeMediaLibraryItem({ kind: 'document', chatId: '123@c.us', url: ASSET('doc1'), name: 'guía.pdf' }, BASE, 'personal');
  assert.deepEqual([available.kind, available.url, available.id], ['document', ASSET('doc1'), '123@c.us:']);
  const link = normalizeMediaLibraryItem({ id: 'l1', kind: 'link', chatId: '123@c.us', url: 'https://ok.example/' }, BASE, 'personal');
  assert.equal(link.links[0].url, 'https://ok.example/');
  assert.equal(normalizeMediaLibraryItem({ kind: 'sticker', chatId: '123@c.us' }, BASE, 'personal'), null);
  assert.equal(normalizeMediaLibraryItem({ kind: 'image', chatId: ' ' }, BASE, 'personal'), null);
  assert.equal(normalizeMediaLibraryItem(null, BASE, 'personal'), null);
});

test('pages normalize with the requested account and never invent a cursor', async () => {
  const client = clientWith('personal', async () => ok('personal', [
    { id: 'i1', kind: 'image', chatId: '123@c.us', url: ASSET('i1') },
    { id: 'i2', kind: 'image', chatId: '123@c.us', url: '/api/media/i2?account=secondary' },
    { id: 'i3', kind: 'nope', chatId: '123@c.us' },
  ], 42));
  const page = await client.page({ kind: 'media' });
  assert.deepEqual(page.items.map(item => [item.id, item.url]), [['i1', ASSET('i1')], ['i2', '']]);
  assert.equal(page.nextCursor, '42');
  const empty = await clientWith('personal', async () => ok('personal', [], undefined))
    .page({});
  assert.deepEqual([empty.items.length, empty.nextCursor], [0, null]);
});
