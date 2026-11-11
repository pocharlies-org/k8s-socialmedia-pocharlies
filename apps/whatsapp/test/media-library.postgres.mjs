// Read-only PostgreSQL integration: CTE fixtures shadow real table names.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readMediaLibrary } from '../lib/media-library.mjs';
const container = process.env.POSTGRES_QA_CONTAINER;
if (!container) throw new Error('Set POSTGRES_QA_CONTAINER to a PostgreSQL test container');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const literal = value => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const fixtures = `WITH messages(id, wa_message_id, conversation_id, account, platform, is_deleted, content, direction, message_type, wa_timestamp, sender_wa_id) AS (
  VALUES
  ('${id(1)}'::uuid,'one','chat-a','a','whatsapp',false,'One https://example.com','OUTBOUND','IMAGE','2026-09-27 10:00:00.123456'::timestamp,NULL),
  ('${id(2)}'::uuid,'two','chat-a','a','whatsapp',false,'Two','INBOUND','IMAGE','2026-09-27 10:00:00.123456+00'::timestamptz,'sender-a'),
  ('${id(3)}'::uuid,'three','chat-b','b','whatsapp',false,'Other account','OUTBOUND','IMAGE','2026-09-27 11:00:00+00'::timestamptz,NULL),
  ('${id(4)}'::uuid,'four','1@newsletter','a','whatsapp',false,'Channel','OUTBOUND','IMAGE','2026-09-27 11:00:00+00'::timestamptz,NULL),
  ('${id(5)}'::uuid,'five','chat-a','a','whatsapp',false,'PDF','OUTBOUND','DOCUMENT','2026-09-27 11:00:00+00'::timestamptz,NULL),
  ('${id(6)}'::uuid,'six','chat-a','a','whatsapp',true,'Deleted','OUTBOUND','IMAGE','2026-09-27 11:00:00+00'::timestamptz,NULL),
  ('${id(7)}'::uuid,'seven','chat-a','a','whatsapp',false,'Report https://example.org/report','INBOUND','TEXT','2026-09-27 12:00:00+00'::timestamptz,'sender-a')
), conversations(id,account,name) AS (
  VALUES ('chat-a','a','Alpha'),('chat-b','b','Beta'),('1@newsletter','a','Channel')
), participants(id,account,name,push_name) AS (
  VALUES ('sender-a','a','Remitente objetivo','Apodo buscable'),
         ('sender-a','b','Nombre de otra cuenta','Otro apodo')
), attachments(id,message_id,mime_type,file_name,file_size) AS (
  VALUES ('${id(101)}'::uuid,'${id(1)}'::uuid,'image/jpeg','first.jpg',123),
         ('${id(102)}'::uuid,'${id(1)}'::uuid,'image/jpeg','second.jpg',456),
         ('${id(105)}'::uuid,'${id(5)}'::uuid,'application/pdf','doc.pdf',789)
)`;
const query = async (sql, args) => {
  const statement = sql.replace(/\$(\d+)/g, (_, n) => literal(args[Number(n) - 1]));
  const output = execFileSync('docker', ['exec', '-i', container, 'sh', '-c', 'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"'], {
    input: `BEGIN READ ONLY;\nSET LOCAL TIME ZONE 'Europe/Madrid';\n${fixtures} SELECT COALESCE(json_agg(result),'[]'::json) FROM (${statement}) result;\nROLLBACK;\n`, encoding: 'utf8',
  });
  return JSON.parse(output.trim());
};
for (const order of ['newest', 'oldest']) {
  const items = [];
  let cursor;
  do {
    const result = await readMediaLibrary({ account: 'a', query, params: new URLSearchParams({ order, limit: '1', ...(cursor ? { cursor } : {}) }) });
    items.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map(item => item.id)).size, 3);
  assert(items.every(item => item.chatId === 'chat-a'));
  assert.deepEqual(items.map(item => item.id), order === 'newest' ? [id(2), id(102), id(101)] : [id(101), id(102), id(2)]);
}
const docs = await readMediaLibrary({ account: 'a', query, params: new URLSearchParams({ kind: 'documents', sender: 'me' }) });
assert.equal(docs.items.length, 1);
assert.equal(docs.items[0].name, 'doc.pdf');
const links = await readMediaLibrary({ account: 'a', query, params: new URLSearchParams({ kind: 'links' }) });
assert.deepEqual(links.items.map(item => item.url), ['https://example.org/report', 'https://example.com/']);
const combined = await readMediaLibrary({ account: 'a', query, params: new URLSearchParams({ kind: 'all' }) });
assert.deepEqual(combined.items.map(item => item.kind), ['link', 'document', 'image', 'image', 'image']);
assert(combined.items.every(item => item.chatId === 'chat-a'));
const combinedIds = [];
let combinedCursor;
do {
  const page = await readMediaLibrary({account: 'a', query, params: new URLSearchParams({kind: 'all', limit: '2', ...(combinedCursor ? {cursor: combinedCursor} : {})})});
  combinedIds.push(...page.items.map(item => item.id));
  combinedCursor = page.nextCursor;
} while (combinedCursor);
assert.deepEqual(combinedIds, combined.items.map(item => item.id));
for (const name of ['Remitente objetivo', 'Apodo buscable']) {
  const found = await readMediaLibrary({ account: 'a', query, params: new URLSearchParams({ q: name }) });
  assert.deepEqual(found.items.map(item => item.id), [id(2)]);
}
const otherAccountName = await readMediaLibrary({ account: 'a', query, params: new URLSearchParams({ q: 'Nombre de otra cuenta' }) });
assert.deepEqual(otherAccountName.items, []);
console.log(JSON.stringify({ status: 'passed', dataSource: 'synthetic CTEs', transaction: 'READ ONLY', paginationOrders: 2 }));
