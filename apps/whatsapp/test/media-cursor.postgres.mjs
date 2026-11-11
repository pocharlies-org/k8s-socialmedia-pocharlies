// Read-only PostgreSQL integration for GET /api/chats/media keyset pagination.
// CTE fixtures shadow real table names; the real route runs over HTTP via createApp.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const container = process.env.POSTGRES_QA_CONTAINER;
if (!container) throw new Error('Set POSTGRES_QA_CONTAINER to a PostgreSQL test container');

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const literal = value => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(',')}]::text[]`;
  return `'${String(value).replaceAll("'", "''")}'`;
};
const tie = "'2026-09-27 10:00:00.123456+00'::timestamptz";
const msg = (n, chat, account, type, ts, deleted = false, content = null) =>
  `('${id(n)}'::uuid,'wa-${n}','${chat}','${account}','whatsapp',${deleted},${literal(content ?? `content ${n}`)},'${type}',${ts})`;
const fixtures = `WITH messages(id, wa_message_id, conversation_id, account, platform, is_deleted, content, message_type, wa_timestamp) AS (
  VALUES
  ${msg(1, 'chat-a', 'personal', 'IMAGE', tie)},
  ${msg(2, 'chat-a', 'personal', 'IMAGE', tie)},
  ${msg(3, 'chat-a', 'personal', 'IMAGE', tie)},
  ${msg(4, 'chat-a', 'personal', 'IMAGE', tie)},
  ${msg(5, 'chat-a', 'personal', 'IMAGE', tie)},
  ${msg(6, 'chat-a', 'personal', 'IMAGE', "'2026-09-26 10:00:00+00'::timestamptz")},
  ${msg(7, 'chat-a', 'personal', 'VIDEO', "'2026-09-28 10:00:00+00'::timestamptz")},
  ${msg(8, 'chat-a', 'personal', 'TEXT', tie, false, 'plain text')},
  ${msg(9, 'chat-a', 'personal', 'TEXT', tie, false, 'see https://example.test/x')},
  ${msg(10, 'chat-a', 'personal', 'DOCUMENT', tie)},
  ${msg(11, 'chat-a', 'personal', 'IMAGE', tie, true)},
  ${msg(12, 'chat-b', 'personal', 'IMAGE', tie)},
  ${msg(13, 'chat-a', 'secondary', 'IMAGE', tie)}
), attachments(id, message_id, mime_type, file_name, file_size, file_url, caption) AS (
  VALUES
  ('${id(201)}'::uuid,'${id(1)}'::uuid,'image/jpeg','one-a.jpg',11,NULL,NULL),
  ('${id(202)}'::uuid,'${id(1)}'::uuid,'image/jpeg','one-b.jpg',22,NULL,'second'),
  ('${id(210)}'::uuid,'${id(10)}'::uuid,'application/pdf','report.pdf',33,NULL,NULL)
), conversations(id, account, name, wa_chat_id, is_group, archived, unread_count, avatar_url) AS (
  VALUES
  ('chat-a','personal','Alpha','chat-a',false,false,0,NULL),
  ('chat-b','personal','Beta','chat-b',false,false,0,NULL),
  ('chat-a','secondary','Other','chat-a',false,false,0,NULL)
)`;
const query = async (sql, args = []) => {
  const statement = sql.replace(/\$(\d+)/g, (_, n) => literal(args[Number(n) - 1]));
  const output = execFileSync('docker', ['exec', '-i', container, 'sh', '-c',
    'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"'], {
    input: `BEGIN READ ONLY;\nSET LOCAL TIME ZONE 'UTC';\n${fixtures}\nSELECT COALESCE(json_agg(result),'[]'::json) FROM (${statement}) result;\nROLLBACK;\n`,
    encoding: 'utf8',
  });
  return { rows: JSON.parse(output.trim() || '[]') };
};

const dir = await mkdtemp(join(tmpdir(), 'whatsapp-media-cursor-'));
const auth = `Basic ${Buffer.from('operator:password').toString('base64')}`;
const app = await createApp({
  env: {
    DATA_DIR: dir, UI_AUTH_USERNAME: 'operator', UI_AUTH_PASSWORD: 'password',
    APP_PUBLIC_URL: 'https://wa.example', APP_ENABLE_SENDING: 'true',
    PERSONAL_SECRET: 'personal-secret', SECONDARY_SECRET: 'secondary-secret',
    MEDIA_ALLOWED_ORIGINS: 'https://media.example',
  },
  db: { query },
  registry: [
    { channel: 'whatsapp', accountId: 'personal', secretEnv: 'PERSONAL_SECRET', connectorUrl: 'http://personal-connector' },
    { channel: 'whatsapp', accountId: 'secondary', secretEnv: 'SECONDARY_SECRET', connectorUrl: 'http://secondary-connector' },
  ],
  fetchImpl: async () => Response.json({ ok: true }),
});
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const get = async path => {
  const response = await fetch(base + path, { headers: { authorization: auth } });
  const body = response.status === 200 ? await response.json() : await response.text();
  return { status: response.status, body };
};
const key = item => `${item.messageId}:${item.id}`;

try {
  const gallery = await get('/api/chats/media?account=personal&chat=chat-a&kind=gallery&limit=200');
  assert.equal(gallery.status, 200);
  assert.equal(gallery.body.nextCursor, null);
  // Newer video, five tie-timestamp images (id DESC), then the older image. Deleted rows,
  // chat-b and the secondary-account row of the same conversation id are absent.
  assert.equal(gallery.body.items.length, 8);
  assert.equal(gallery.body.items.filter(item => item.messageId === 'wa-11').length, 0);
  assert.equal(gallery.body.items.filter(item => item.messageId === 'wa-12').length, 0);
  assert.equal(gallery.body.items.filter(item => item.messageId === 'wa-13').length, 0);
  const split = gallery.body.items.filter(item => item.messageId === 'wa-1').map(item => item.name);
  assert.deepEqual(split, ['one-b.jpg', 'one-a.jpg']);

  for (const kind of ['gallery', 'all']) {
    const baseline = (await get(`/api/chats/media?account=personal&chat=chat-a&kind=${kind}&limit=200`)).body;
    const expected = baseline.items.map(key);
    for (const limit of [1, 2, 3, 5]) {
      const seen = [];
      let cursor = null;
      let pages = 0;
      for (; ; ) {
        const page = await get(`/api/chats/media?account=personal&chat=chat-a&kind=${kind}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        assert.equal(page.status, 200, `${kind} limit=${limit}`);
        seen.push(...page.body.items.map(key));
        cursor = page.body.nextCursor;
        pages += 1;
        assert.ok(pages < 30, 'pagination never terminated');
        if (!cursor) break;
      }
      assert.deepEqual(seen, expected, `${kind} limit=${limit} lost or duplicated rows`);
      assert.equal(new Set(seen).size, seen.length, `${kind} limit=${limit} duplicates`);
    }
  }
  const all = (await get('/api/chats/media?account=personal&chat=chat-a&kind=all&limit=200')).body;
  assert.equal(all.items.length, 11);
  assert.deepEqual(all.items.filter(item => item.kind === 'document').map(item => item.name), ['report.pdf']);
  assert.equal(all.items.find(item => item.messageId === 'wa-9').url, 'https://example.test/x');

  const first = (await get('/api/chats/media?account=personal&chat=chat-a&kind=gallery&limit=2')).body;
  const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
  assert.equal(decoded.v, 1);
  assert.match(decoded.scope, /^[0-9a-f]{64}$/);
  const secondViaCursor = await get(`/api/chats/media?account=personal&chat=chat-a&kind=gallery&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert.equal(secondViaCursor.status, 200);
  const secondViaBefore = await get(`/api/chats/media?account=personal&chat=chat-a&kind=gallery&limit=2&before=${encodeURIComponent(first.nextCursor)}`);
  assert.deepEqual(secondViaBefore.body.items.map(key), secondViaCursor.body.items.map(key));

  // Legacy raw timestamps keep the old strict "<" semantics: newer rows and every tie row
  // at the cutoff are skipped, which is exactly the loss the keyset cursor removes.
  const legacy = await get(`/api/chats/media?account=personal&chat=chat-a&kind=gallery&limit=50&before=${encodeURIComponent('2026-09-27T10:00:00.123456Z')}`);
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.body.items.map(item => item.messageId), ['wa-6']);

  for (const [label, path] of [
    ['malformed cursor', `/api/chats/media?account=personal&chat=chat-a&kind=gallery&cursor=${encodeURIComponent('nope!!')}`],
    ['malformed before', '/api/chats/media?account=personal&chat=chat-a&kind=gallery&before=not-a-time'],
    ['epoch millis before', '/api/chats/media?account=personal&chat=chat-a&kind=gallery&before=1759000000000'],
    ['oversized cursor', `/api/chats/media?account=personal&chat=chat-a&kind=gallery&cursor=${'a'.repeat(2049)}`],
    ['cross-kind cursor', `/api/chats/media?account=personal&chat=chat-a&kind=all&cursor=${encodeURIComponent(first.nextCursor)}`],
    ['cross-chat cursor', `/api/chats/media?account=personal&chat=chat-b&kind=gallery&cursor=${encodeURIComponent(first.nextCursor)}`],
  ]) assert.equal((await get(path)).status, 400, label);

  // Account isolation: chat-a also exists for secondary and must only expose its own row.
  const scoped = await get('/api/chats/media?account=secondary&chat=chat-a&kind=gallery&limit=200');
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.body.items.map(item => item.messageId), ['wa-13']);
  assert.equal((await get('/api/chats/media?account=nope&chat=chat-a')).status, 404);
  assert.equal((await get('/api/chats/media?account=personal&chat=nope-chat')).status, 404);
  assert.equal((await get('/api/chats/media?account=personal&chat=chat-a&kind=images')).status, 400);
  assert.equal((await get('/api/chats/media?account=personal&chat=chat-a&limit=201')).status, 400);

  // No provider-secret-shaped fields leak into the media projection.
  assert.doesNotMatch(JSON.stringify(gallery.body), /mediaKey|messageSecret|"raw"/);

  console.log(JSON.stringify({ status: 'passed', dataSource: 'synthetic CTEs', transaction: 'READ ONLY', pagination: 'gallery+all x limits 1,2,3,5' }));
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
