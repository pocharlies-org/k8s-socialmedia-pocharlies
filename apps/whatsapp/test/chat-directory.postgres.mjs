import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readChatDirectory } from '../lib/chat-directory.mjs';

const container = process.env.POSTGRES_QA_CONTAINER;
if (!container) throw new Error('Set POSTGRES_QA_CONTAINER to a PostgreSQL test container');
const literal = value => value == null ? 'NULL' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const fixtures = `WITH conversations AS (
  SELECT 'chat-' || lpad(n::text, 4, '0') AS id, n || '@c.us' AS wa_chat_id,
    'a'::text AS account, 'Contact ' || n AS name, false AS is_group,
    0 AS unread_count, (n > 650) AS archived, NULL::text AS avatar_url,
    CASE WHEN n % 7 = 0 THEN NULL ELSE '2026-09-27 12:00:00'::timestamp + (n % 3) * interval '1 microsecond' END AS last_message_at
  FROM generate_series(1, 700) n
  UNION ALL SELECT 'other','phone-other','b','Other',false,0,false,NULL,'2026-10-01'::timestamp
), messages AS (
  SELECT NULL::text AS id, NULL::text AS conversation_id, NULL::text AS account,
    NULL::text AS platform, false AS is_deleted, NULL::text AS content,
    NULL::text AS direction, NULL::text AS message_type, NULL::timestamp AS wa_timestamp,
    NULL::text AS sender_wa_id WHERE false
), participants AS (
  SELECT NULL::text AS id, NULL::text AS account, NULL::text AS name, NULL::text AS push_name WHERE false
)`;
const query = async (sql, args) => {
  const statement = sql.replace(/\$(\d+)/g, (_, n) => literal(args[Number(n) - 1]));
  const output = execFileSync('docker', ['exec','-i',container,'sh','-c','exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"'], {
    input:`BEGIN READ ONLY;\n${fixtures} SELECT COALESCE(json_agg(result),'[]'::json) FROM (${statement}) result;\nROLLBACK;\n`, encoding:'utf8',
  });
  return JSON.parse(output.trim());
};
for (const archived of [false,true]) {
  const all=[]; let cursor; let pages=0;
  do {
    const result=await readChatDirectory({query,account:'a',archived,limit:37,cursor});
    all.push(...result.chats); cursor=result.nextCursor; pages++;
    assert(pages < 25,'cursor did not terminate');
  } while(cursor);
  assert.equal(all.length,archived?50:650);
  assert.equal(new Set(all.map(chat=>chat.id)).size,all.length);
  assert(all.every(chat=>chat.archived===archived && chat.id!=='other'));
  assert(all.every(chat=>!('_sortTimestamp' in chat)));
}
console.log(JSON.stringify({status:'passed',active:650,archived:50,precision:'microseconds',nullDates:true,transaction:'READ ONLY'}));
