import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaLibraryOptions, publicLinks, readMediaLibrary } from '../lib/media-library.mjs';

const id = suffix => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const row = (number, extra = {}) => ({ id: id(number), attachment_id: id(number + 100), conversation_id: 'secondary:123@lid', chat_name: 'Contacto', wa_timestamp: '2026-09-27T10:00:00.000Z', cursor_timestamp: '2026-09-27 10:00:00.123456+00', message_type: 'IMAGE', direction: 'OUTBOUND', file_name: 'photo.jpg', mime_type: 'image/jpeg', ...extra });
const params = value => new URLSearchParams(value);

test('library scopes all surfaces by account and hides reactions and Novedades', async () => {
  let call;
  const result = await readMediaLibrary({ account: 'secondary', params: params({ kind: 'media', sender: 'me', q: 'a%_b' }), query: async (sql, args) => { call = { sql, args }; return [row(1)]; } });
  assert.match(call.sql, /m\.account=\$1/);
  assert.match(call.sql, /c\.account=m\.account/);
  assert.match(call.sql, /NOT m\.is_deleted/);
  assert.match(call.sql, /REACTION/);
  assert.match(call.sql, /@newsletter/);
  assert.match(call.sql, /status@broadcast/);
  assert.match(call.sql, /m\.direction = 'OUTBOUND'/);
  assert.match(call.sql, /sender\.id=m\.sender_wa_id AND sender\.account=m\.account/);
  assert.match(call.sql, /sender\.name ILIKE \$2 OR sender\.push_name ILIKE \$2/);
  assert.deepEqual(call.args, ['secondary', '%a\\%\\_b%', 51]);
  assert.equal(result.account, 'secondary');
  assert.equal(result.items[0].kind, 'image');
  assert.equal(result.items[0].url, `/api/media/${id(101)}?account=secondary&chat=secondary%3A123%40lid`);
  assert.equal(result.nextCursor, null);
});

test('all-kind search returns media, documents and links in one account-scoped page', async () => {
  let sql;
  const result = await readMediaLibrary({account: 'personal', params: params({kind: 'all', q: 'report'}), query: async (statement) => {
    sql = statement;
    return [
      row(1, {message_type: 'IMAGE', file_name: 'report.jpg'}),
      row(2, {message_type: 'DOCUMENT', file_name: 'report.pdf'}),
      row(3, {message_type: 'TEXT', attachment_id: null, content: 'https://example.com/report'}),
    ];
  }});
  assert.match(sql, /m\.account=\$1/);
  assert.match(sql, /m\.message_type IN \('IMAGE','VIDEO','AUDIO','STICKER','DOCUMENT'\) OR m\.content/);
  assert.deepEqual(result.items.map(item => item.kind), ['image', 'document', 'link']);
  assert.deepEqual(result.items[2].links, [{url: 'https://example.com/report'}]);
  assert.equal(result.items[2].url, 'https://example.com/report');
});

test('cursor preserves microseconds and attachment identity across equal-time items', async () => {
  const first = await readMediaLibrary({ account: 'a', params: params({ limit: '1' }), query: async () => [row(1), row(2)] });
  let call;
  await readMediaLibrary({ account: 'a', params: params({ limit: '1', cursor: first.nextCursor }), query: async (sql, args) => { call = { sql, args }; return []; } });
  assert.match(call.sql, /m\.wa_timestamp, m\.id::text, COALESCE\(a.id::text, ''\)\) </);
  assert.deepEqual(call.args.slice(1, 4), ['2026-09-27 10:00:00.123456+00', id(1), id(101)]);
  for (const change of [{ kind: 'documents' }, { sender: 'others' }, { order: 'oldest' }, { q: 'different' }]) {
    assert.throws(() => mediaLibraryOptions('a', params({ ...change, cursor: first.nextCursor })), /cursor/);
  }
  assert.throws(() => mediaLibraryOptions('b', params({ cursor: first.nextCursor })), /cursor/);
});

test('oldest and other-sender filters are parameter-safe and documents are separate', async () => {
  let sql;
  const result = await readMediaLibrary({ account: 'a', params: params({ kind: 'documents', order: 'oldest', sender: 'others' }), query: async statement => { sql = statement; return [row(1, { message_type: 'DOCUMENT', file_name: 'notes.pdf', mime_type: 'application/pdf', direction: 'INBOUND' })]; } });
  assert.match(sql, /m\.message_type='DOCUMENT'/);
  assert.match(sql, /m\.direction <> 'OUTBOUND'/);
  assert.match(sql, /ORDER BY m\.wa_timestamp ASC/);
  assert.equal(result.items[0].kind, 'document');
  assert.equal(result.items[0].fromMe, false);
});

test('longest orders by stored duration with unknown media last and a stable cursor', async () => {
  const first = await readMediaLibrary({account: 'a', params: params({kind: 'media', order: 'longest', limit: '1'}), query: async (sql, args) => {
    assert.match(sql, /ORDER BY COALESCE\(NULLIF\(a\.duration_seconds, 0\), NULLIF\(a\.duration, 0\), -1\) DESC, m\.wa_timestamp DESC/);
    assert.deepEqual(args, ['a', 2]);
    return [row(1, {message_type: 'VIDEO', duration_seconds: 95}), row(2, {message_type: 'AUDIO', duration_seconds: 30})];
  }});
  assert.equal(first.items[0].durationSeconds, 95);
  let call;
  await readMediaLibrary({account: 'a', params: params({kind: 'media', order: 'longest', limit: '1', cursor: first.nextCursor}), query: async (sql, args) => {
    call = {sql, args}; return [];
  }});
  assert.match(call.sql, /\(COALESCE\(NULLIF\(a\.duration_seconds, 0\), NULLIF\(a\.duration, 0\), -1\), m\.wa_timestamp, m\.id::text, COALESCE\(a\.id::text, ''\)\) </);
  assert.deepEqual(call.args.slice(1, 5), [95, '2026-09-27 10:00:00.123456+00', id(1), id(101)]);
  assert.throws(() => mediaLibraryOptions('a', params({order: 'newest', cursor: first.nextCursor})), /cursor/);
  const bad = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
  delete bad.duration;
  assert.throws(() => mediaLibraryOptions('a', params({order: 'longest', cursor: Buffer.from(JSON.stringify(bad)).toString('base64url')})), /cursor/);
  bad.duration = 2147483648;
  assert.throws(() => mediaLibraryOptions('a', params({order: 'longest', cursor: Buffer.from(JSON.stringify(bad)).toString('base64url')})), /cursor/);
  const legacy = await readMediaLibrary({account: 'a', params: params({order: 'longest'}), query: async () => [row(3, {duration_seconds: 0, duration: 12})]});
  assert.equal(legacy.items[0].durationSeconds, 12);
});

test('link cards preserve all distinct safe links and never expose provider media URLs', async () => {
  let sql;
  const result = await readMediaLibrary({ account: 'a', params: params({ kind: 'links' }), query: async statement => { sql = statement; return [row(1, { attachment_id: '', content: 'https://example.com/a https://example.org/b https://example.com/a', file_url: 'https://provider.invalid/private-token' })]; } });
  assert.doesNotMatch(sql, /JOIN attachments/);
  assert.deepEqual(result.items[0].links, [{ url: 'https://example.com/a' }, { url: 'https://example.org/b' }]);
  assert(!JSON.stringify(result).includes('private-token'));
  assert.deepEqual(publicLinks('javascript:alert(1) https://user:password@example.com/x https://ok.example/path.'), [{ url: 'https://ok.example/path' }]);
});

test('unavailable media remains an item without an invented download URL', async () => {
  const result = await readMediaLibrary({ account: 'a', params: params({}), query: async () => [row(1, { attachment_id: '' })] });
  assert.equal(result.items[0].url, null);
  assert.equal(result.items[0].messageId, id(1));
});

test('invalid filters and malformed cursors are refused before querying', async () => {
  for (const invalid of [{ kind: 'everything' }, { sender: 'any' }, { order: 'drop table' }, { limit: '0' }, { limit: '201' }, { cursor: 'nonsense' }, { q: 'x'.repeat(401) }]) {
    await assert.rejects(readMediaLibrary({ account: 'a', params: params(invalid), query: async () => { assert.fail('query must not execute'); } }), /Invalid|too long/);
  }
});
