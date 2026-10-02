import test from 'node:test';
import assert from 'node:assert/strict';
import { filterChannels, groupAuthors, normalizeNovedadesAuthor, normalizeNovedadesChannel, normalizeNovedadesPost, normalizeNovedadesStatus, novedadesMediaUrl, readableAuthor, safeNovedadesLink, statusIsVisible, statusRemainingMs, ttlLabel, visibleStatusQueue } from '../public/novedades-ui.mjs';

// Shapes below are copied from lib/novedades-proxy.mjs projections, not invented.
const account = 'personal';
const base = 'https://wa.example/';
const mediaUrl = (kind, jid, messageId) => `/api/novedades/media?${new URLSearchParams(messageId ? { account, kind, jid, messageId } : { account, kind, jid })}`;

const statusFixture = overrides => ({
  id: 'status-1',
  author: '34600111222@c.us',
  text: null,
  kind: 'image',
  timestamp: '2026-09-28T06:00:00.000Z',
  timestampMs: Date.parse('2026-09-28T06:00:00.000Z'),
  mimeType: 'image/jpeg',
  mediaKind: 'image',
  mediaSizeBytes: 1234,
  mediaFileName: 'foto.jpg',
  mediaDurationSeconds: null,
  deleted: false,
  mediaUrl: mediaUrl('status', '34600111222@c.us', 'status-1'),
  expiresAt: '2026-09-29T06:00:00.000Z',
  remainingMs: 86_400_000,
  active: true,
  freshnessUnknown: false,
  seenAt: null,
  ...overrides,
});

test('proxied status items normalize their media through the account-scoped proxy only', () => {
  const clock = () => 5000;
  const status = normalizeNovedadesStatus(statusFixture(), account, base, clock);
  assert.equal(status.id, 'status-1');
  assert.equal(status.kind, 'image');
  assert.equal(status.ttlBase, 5000);
  assert.equal(status.mediaUrl, '/api/novedades/media?account=personal&kind=status&jid=34600111222%40c.us&messageId=status-1');
  assert.equal(normalizeNovedadesStatus(statusFixture(), 'secondary', base, clock).mediaUrl, '');
  assert.equal(normalizeNovedadesStatus(statusFixture({ mediaUrl: 'https://mmwebwhatsapp.net/_next/media' }), account, base, clock).mediaUrl, '');
  assert.equal(normalizeNovedadesStatus(statusFixture({ kind: 'poll' }), account, base, clock), null);
  assert.equal(normalizeNovedadesStatus(statusFixture({ kind: 'text', text: 'hola', mediaUrl: null }), account, base, clock).mediaUrl, '');
});

test('status expiry counts elapsed monotonic time from receipt, never the client wall clock', () => {
  const clock = () => 1000;
  const status = normalizeNovedadesStatus(statusFixture({ remainingMs: 60_000 }), account, base, clock);
  assert.equal(statusRemainingMs(status, 1000), 60_000);
  assert.equal(statusRemainingMs(status, 31_000), 30_000);
  assert.equal(statusIsVisible(status, 1000), true);
  assert.equal(statusIsVisible(status, 60_999), true);
  assert.equal(statusIsVisible(status, 61_000), false);
  // A client wall clock one hour behind cannot keep the dead row visible:
  // expiresAt would still claim ~1h of life while the monotonic budget is gone.
  const staleWall = { ...status, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  assert.equal(statusIsVisible(staleWall, 70_000), false);
  assert.equal(ttlLabel(status, 1000), 'Caduca en 1 min');
  const hours = normalizeNovedadesStatus(statusFixture({ remainingMs: 7_200_000 }), account, base, () => 0);
  assert.equal(ttlLabel(hours, 60_000), 'Caduca en 1 h 59 min');
  assert.equal(ttlLabel(status, 40_000), 'Caduca en 0 min');
  assert.equal(ttlLabel(status, 61_000), 'Expirado');
});

test('deleted, deactivated and unknown-freshness statuses never appear', () => {
  const clock = () => 1000;
  for (const overrides of [{ deleted: true }, { active: false }, { freshnessUnknown: true }, { remainingMs: 0, expiresAt: null }]) {
    const status = normalizeNovedadesStatus(statusFixture(overrides), account, base, clock);
    assert.equal(statusIsVisible(status, 1000), false, JSON.stringify(overrides));
  }
});

test('author summaries keep the Windows grouping: own, unseen, then viewed', () => {
  const authors = [
    normalizeNovedadesAuthor({ id: '34600000003@c.us', name: 'Luis', own: false, count: 2, total: 9, unseen: 0, latestTimestamp: '2026-09-28T04:00:00.000Z' }),
    normalizeNovedadesAuthor({ id: '34600000001@c.us', name: 'Ana', own: false, count: 3, total: 12, unseen: 2, latestTimestamp: '2026-09-28T06:00:00.000Z' }),
    normalizeNovedadesAuthor({ id: '34600000002@c.us', name: null, own: true, count: 1, total: 4, unseen: 1, latestTimestamp: '2026-09-28T05:00:00.000Z' }),
    normalizeNovedadesAuthor({ id: '123456789012345678@lid', name: null, own: false, count: 1, total: 1, unseen: 1, latestTimestamp: '2026-09-28T07:00:00.000Z' }),
  ];
  const sections = groupAuthors(authors);
  assert.deepEqual(sections.map(section => section.kind), ['own', 'recent', 'viewed']);
  assert.equal(sections[0].items[0].id, '34600000002@c.us');
  assert.deepEqual(sections[1].items.map(item => item.id), ['123456789012345678@lid', '34600000001@c.us']);
  assert.deepEqual(sections[2].items.map(item => item.id), ['34600000003@c.us']);
});

test('channel search is local, case-insensitive and paginates independently', () => {
  const channels = [
    normalizeNovedadesChannel({ id: '123456789012345678@newsletter', name: 'Deportes', description: 'Resultados', subscribers: 10, avatarAvailable: true, avatarUrl: mediaUrl('avatar', '123456789012345678@newsletter'), verification: 'verified' }, account, base),
    normalizeNovedadesChannel({ id: '876543210987654321@newsletter', name: 'Clima', description: 'Parte diario', subscribers: null, avatarAvailable: false, avatarUrl: null }, account, base),
  ];
  assert.deepEqual(filterChannels(channels, 'deportes').map(item => item.id), ['123456789012345678@newsletter']);
  assert.deepEqual(filterChannels(channels, 'PARTE').map(item => item.id), ['876543210987654321@newsletter']);
  assert.equal(filterChannels(channels, '').length, 2);
  assert.deepEqual(filterChannels(channels, '  ').map(item => item.id), channels.map(item => item.id));
  assert.equal(channels[0].avatarUrl, '/api/novedades/media?account=personal&kind=avatar&jid=123456789012345678%40newsletter');
  assert.equal(channels[1].avatarUrl, '');
});

test('deleted and unrenderable posts never reach the timeline', () => {
  assert.equal(normalizeNovedadesPost({ id: 'p1', kind: 'text', text: 'hola', timestamp: '2026-09-28T06:00:00.000Z', deleted: true }, account, base), null);
  assert.equal(normalizeNovedadesPost({ id: 'p2', kind: 'sticker', text: null, timestamp: null }, account, base), null);
  const post = normalizeNovedadesPost({ id: 'p3', kind: 'video', text: null, timestamp: '2026-09-28T06:00:00.000Z', mediaUrl: mediaUrl('channel', '123456789012345678@newsletter', 'p3') }, account, base);
  assert.equal(post.mediaUrl, '/api/novedades/media?account=personal&kind=channel&jid=123456789012345678%40newsletter&messageId=p3');
});

test('status queues deduplicate, drop invisible rows and stay newest-first', () => {
  const clock = () => 1000;
  const older = normalizeNovedadesStatus(statusFixture({ id: 'older', timestamp: '2026-09-27T06:00:00.000Z' }), account, base, clock);
  const newer = normalizeNovedadesStatus(statusFixture({ id: 'newer', timestamp: '2026-09-28T09:00:00.000Z' }), account, base, clock);
  const dead = normalizeNovedadesStatus(statusFixture({ id: 'dead', deleted: true }), account, base, clock);
  const queue = visibleStatusQueue([older, newer, dead, newer, null], clock());
  assert.deepEqual(queue.map(item => item.id), ['newer', 'older']);
});

test('a received one-second status leaves the queue when the injected clock reaches its TTL', () => {
  let now = 10_000;
  const expiring = normalizeNovedadesStatus(statusFixture({ id: 'short', remainingMs: 1000 }), account, base, () => now);
  const lasting = normalizeNovedadesStatus(statusFixture({ id: 'long', remainingMs: 5000 }), account, base, () => now);
  assert.deepEqual(visibleStatusQueue([expiring, lasting], now).map(item => item.id), ['short', 'long']);
  now += 1000;
  assert.deepEqual(visibleStatusQueue([expiring, lasting], now).map(item => item.id), ['long']);
});

test('identities fall back to numbers or private ids, never to invented names', () => {
  assert.equal(readableAuthor('34600111222@c.us', 'Ana'), 'Ana');
  assert.equal(readableAuthor('34600111222@c.us', ''), '+34600111222');
  assert.equal(readableAuthor('34600111222@s.whatsapp.net', ''), '+34600111222');
  assert.equal(readableAuthor('99887766554433221@lid', ''), 'ID privado ···221');
  assert.equal(readableAuthor('', ''), 'Desconocido');
});

test('only http(s) text becomes a link', () => {
  assert.equal(safeNovedadesLink('javascript:alert(1)'), null);
  assert.equal(safeNovedadesLink('https://example.com/x),')?.href, 'https://example.com/x');
  assert.equal(safeNovedadesLink('https://example.com').rel, 'noopener noreferrer nofollow');
});
