import test from 'node:test';
import assert from 'node:assert/strict';
import { readContactDirectory, contactDirectoryOptions } from '../lib/contact-directory.mjs';

const calls = () => {
  const log = [];
  const query = async (sql, args) => { log.push({ sql, args }); return log.length % 2 === 1 ? rows() : [stats()]; };
  return { log, query };
};
// The library issues a page query and a totals query per request.
const rows = (...items) => items;
const stats = (overrides = {}) => ({
  total: '1340', matched: '1340', directChatIdentities: '164', groupMemberIdentities: '561',
  contactIdentities: '972', savedNames: '22', latestSyncAt: '2026-09-27 20:00:02.671893+00',
  unmappedLidChats: '4', ...overrides,
});

const entry = (overrides = {}) => ({
  key: '34600111222', phone: '34600111222', lid: null, chat_id: null, has_chat: false,
  chat_archived: false, photo_url: null, photo_owner: null, origin_rank: 2,
  label: 'Ana', label_sort: 'ana', label_rank: 1, source: 'saved', ...overrides,
});

test('every directory read is bound to the selected account and never sends', async () => {
  const { log, query } = calls();
  const result = await readContactDirectory({ account: 'secondary', params: new URLSearchParams(), query, sendingEnabled: true });
  assert.equal(result.account, 'secondary');
  assert.equal(log.length, 2);
  for (const call of log) {
    assert.match(call.sql, /c\.account = \$1|t\.account = \$1|p\.account = \$1/);
    assert.deepEqual(call.args.slice(0, 1), ['secondary']);
    assert.doesNotMatch(call.sql, /INSERT|UPDATE|DELETE/, 'the directory must stay read-only');
  }
  assert.equal(result.sendingEnabled, true);
});

test('a LID row never becomes a phone number and cannot start a chat', async () => {
  const { query } = calls();
  const result = await readContactDirectory({
    account: 'personal',
    params: new URLSearchParams(),
    query: async () => [entry({ key: 'lid:20348712345678', phone: null, lid: '20348712345678', label: 'Ana', source: 'saved', label_rank: 1 })],
  });
  const [contact] = result.contacts;
  assert.equal(contact.phone, null);
  assert.equal(contact.canStart, false);
  assert.equal(contact.canOpen, false);
  assert.equal(contact.kind, 'private');
  assert.equal(contact.sublabel, 'LID ···678');
});

test('a private chat whose wa_chat_id names the number can be opened by that chat', async () => {
  const { query } = calls();
  const result = await readContactDirectory({
    account: 'secondary',
    params: new URLSearchParams(),
    query: async () => [entry({ key: '34600999888', lid: '2034871', chat_id: 'secondary:2034871@lid', has_chat: true, label: 'Jordi', source: 'chat' })],
  });
  const [contact] = result.contacts;
  assert.equal(contact.chatId, 'secondary:2034871@lid');
  assert.equal(contact.canOpen, true);
  assert.equal(contact.canStart, false, 'opening an existing chat must never dial the number');
  assert.equal(contact.kind, 'chat');
  assert.equal(contact.avatarUrl, '/api/chats/secondary%3A2034871%40lid/avatar?account=secondary');
});

test('avatars only reuse authenticated proxies for the same account', async () => {
  const { query } = calls();
  const result = await readContactDirectory({
    account: 'personal',
    params: new URLSearchParams(),
    query: async () => [
      entry({ photo_url: 'https://mmgc.example/private?auth=secret', photo_owner: '2034871@lid', key: 'lid:2034871', phone: null, lid: '2034871', label: 'Bea', chat_id: null }),
      entry({ key: 'x', label: 'Cy', chat_id: '346001@lid' }),
    ],
  });
  assert.equal(result.contacts[0].avatarUrl, '/api/contacts/2034871%40lid/avatar?account=personal');
  assert.equal(result.contacts[1].avatarUrl, '/api/chats/346001%40lid/avatar?account=personal');
  assert(!JSON.stringify(result).includes('mmgc'), 'provider photo URLs must stay server-side');
  assert(!JSON.stringify(result).includes('auth=secret'));
});

test('name search matches the stored name and number search matches digits', async () => {
  const name = calls();
  await readContactDirectory({ account: 'personal', params: new URLSearchParams({ q: 'María' }), query: name.query });
  assert.match(name.log[0].sql, /projected\.label ILIKE \$2/);
  assert.deepEqual(name.log[0].args, ['personal', '%María%', 61]);

  const phone = calls();
  await readContactDirectory({ account: 'personal', params: new URLSearchParams({ q: '+34 600 11' }), query: phone.query });
  assert.match(phone.log[0].sql, /projected\.phone LIKE '%' \|\| \$2 \|\| '%'/);
  assert.match(phone.log[0].sql, /projected\.lid LIKE '%' \|\| \$2 \|\| '%'/);
  assert.deepEqual(phone.log[0].args, ['personal', '3460011', 61]);

  const escaped = calls();
  await readContactDirectory({ account: 'personal', params: new URLSearchParams({ q: '100%_%a' }), query: escaped.query });
  assert.equal(escaped.log[0].args[1], '%100\\%\\_\\%a%');
});

test('one digit is refused instead of answering with noise', async () => {
  await assert.rejects(
    () => readContactDirectory({ account: 'personal', params: new URLSearchParams({ q: '7' }), query: async () => [] }),
    error => error.status === 400
  );
});

test('pagination keeps a keyset cursor and reports the exact total', async () => {
  const { query } = calls();
  const first = await readContactDirectory({
    account: 'personal',
    params: new URLSearchParams({ limit: '2' }),
    query: async sql => (sql.includes('FROM projected\n WHERE') || /SELECT projected\.key/.test(sql)
      ? [entry({ key: 'a', label: 'A', label_sort: 'a' }), entry({ key: 'b', label: 'B', label_sort: 'b' }), entry({ key: 'c', label: 'C', label_sort: 'c' })]
      : [stats({ total: '1340', matched: '1340' })]),
  });
  assert.equal(first.contacts.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.total, 1340);
  assert(first.nextCursor);

  const second = calls();
  await readContactDirectory({
    account: 'personal',
    params: new URLSearchParams({ limit: '2', cursor: first.nextCursor }),
    query: second.query,
  });
  assert.match(second.log[0].sql, /\(projected\.label_rank, projected\.label_sort COLLATE "C", projected\.key COLLATE "C"\) > \(\$2::int, \$3::text, \$4::text\)/);
  assert.deepEqual(second.log[0].args, ['personal', 1, 'b', 'b', 3]);
});

test('a repeated or malformed cursor is rejected, not ignored', async () => {
  for (const cursor of ['not-base64-json', Buffer.from('{"rank":9}').toString('base64url'), Buffer.from('{"rank":1,"sort":"","key":"x"}').toString('base64url')]) {
    await assert.rejects(
      () => readContactDirectory({ account: 'personal', params: new URLSearchParams({ cursor }), query: async () => [] }),
      error => error.status === 400
    );
  }
});

test('the page size is bounded and oversized requests are refused', async () => {
  assert.throws(() => contactDirectoryOptions('personal', new URLSearchParams({ limit: '900' })), error => error.status === 400);
  assert.throws(() => contactDirectoryOptions('personal', new URLSearchParams({ limit: '0' })), error => error.status === 400);
  assert.equal(contactDirectoryOptions('personal', new URLSearchParams()).limit, 60);
});

test('a missing connector contacts table degrades and says so', async () => {
  let attempts = 0;
  const result = await readContactDirectory({
    account: 'personal',
    params: new URLSearchParams(),
    query: async sql => {
      if (!sql.includes('FROM projected\n WHERE') && !/SELECT projected\.key/.test(sql)) return [stats({ total: '12', matched: '12' })];
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('relation "whatsapp_contacts" does not exist');
        error.code = '42P01';
        throw error;
      }
      return [];
    },
  });
  assert.equal(attempts, 2, 'the query must retry without the connector table');
  assert(result.sync.notices.some(notice => notice.includes('no está disponible')));
});

test('the directory states where its data comes from instead of claiming an address book', async () => {
  const { query } = calls();
  const result = await readContactDirectory({ account: 'personal', params: new URLSearchParams(), query, sendingEnabled: false });
  assert.equal(result.sendingEnabled, false);
  assert.equal(result.sync.sources.contactIdentities, 972);
  assert.equal(result.sync.sources.directChatIdentities, 164);
  assert.equal(result.sync.sources.groupMemberIdentities, 561);
  assert.equal(result.sync.identities, 1340);
  assert.equal(result.sync.unmappedLidChats, 4);
  assert.equal(result.sync.connectorCatalog.used, false);
  assert(result.sync.notices.some(notice => notice.includes('@lid')));
  assert(result.sync.notices.some(notice => notice.includes('4 chats')));
});

test('an unknown account yields an empty directory rather than another account', async () => {
  const result = await readContactDirectory({
    account: 'nobody',
    params: new URLSearchParams(),
    query: async () => [],
  });
  assert.deepEqual(result.contacts, []);
});

test('the archived flag is read from the chat that will actually open', async () => {
  const { log, query } = calls();
  await readContactDirectory({ account: 'personal', params: new URLSearchParams(), query, sendingEnabled: true });
  const sql = log[0].sql;
  const order = field => sql.match(new RegExp(`array_agg\\(r\\.${field} ORDER BY (.*?)\\)(?: FILTER \\(WHERE [^)]*\\))?\\)\\[1\\]`))[1];
  assert.equal(order('chat_archived'), order('chat_id'), 'both aggregates must resolve the same row');
  assert.match(order('chat_id'), /\(r\.chat_id IS NULL\), \(r\.lid IS NOT NULL\) DESC, r\.origin_rank, r\.chat_id$/);
  assert.match(sql, /LEFT\(LOWER\(.*\), 600\) AS label_sort/, 'the sort key has to be truncated where the cursor validator caps it');
});

test('a long or astral name still hands back a cursor the validator accepts', async () => {
  const astral = '𝕐'.repeat(600);
  assert.ok(astral.length > 600, 'the fixture must be longer in UTF-16 units than in codepoints');
  const row = entry({ key: '34600111222', label: astral, label_sort: astral.toLowerCase(), label_rank: 3 });
  const { query } = calls();
  const result = await readContactDirectory({
    account: 'personal',
    params: new URLSearchParams({ limit: '1' }),
    query: async () => [row, row],
  });
  assert.equal(result.hasMore, true);
  const next = contactDirectoryOptions('personal', new URLSearchParams({ limit: '1', cursor: result.nextCursor }));
  assert.equal(Array.from(next.cursor.sort).length, 600);
  assert.equal(next.cursor.key, '34600111222');
  assert.throws(
    () => contactDirectoryOptions('personal', new URLSearchParams({
      cursor: Buffer.from(JSON.stringify({ rank: 3, sort: '𝕐'.repeat(601), key: 'x' })).toString('base64url'),
    })),
    error => error.status === 400
  );
});

test('an oversized cursor blob is refused before it is decoded', () => {
  assert.throws(
    () => contactDirectoryOptions('personal', new URLSearchParams({ cursor: 'A'.repeat(9000) })),
    error => error.status === 400
  );
});
