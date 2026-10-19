import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {MESSAGE_BY_DATE_SQL} from '../lib/message-date.mjs';

const container = process.env.POSTGRES_QA_CONTAINER;
if (!container) throw new Error('Set POSTGRES_QA_CONTAINER to a PostgreSQL test container');
const literal = value => Array.isArray(value) ? `ARRAY[${value.map(literal).join(',')}]` : `'${String(value).replaceAll("'", "''")}'`;
const fixtures = `WITH messages(id,wa_message_id,account,conversation_id,platform,is_deleted,message_type,content,metadata,wa_timestamp) AS (
  VALUES
    ('before','before','a','pn','whatsapp',false,'TEXT','before','{}'::jsonb,'2026-10-24T21:59:59.999Z'::timestamptz),
    ('reaction','reaction','a','pn','whatsapp',false,'REACTION','heart','{}','2026-10-24T22:00:00Z'),
    ('deleted','deleted','a','pn','whatsapp',true,'TEXT','deleted','{}','2026-10-24T22:00:00Z'),
    ('other-account','other-account','b','pn','whatsapp',false,'TEXT','private','{}','2026-10-24T22:00:00Z'),
    ('other-chat','other-chat','a','another','whatsapp',false,'TEXT','other','{}','2026-10-24T22:00:00Z'),
    ('other-platform','other-platform','a','pn','telegram',false,'TEXT','other','{}','2026-10-24T22:00:00Z'),
    ('first','first-wa','a','lid','whatsapp',false,'TEXT','first','{}','2026-10-24T22:00:00Z'),
    ('last','last-wa','a','pn','whatsapp',false,'IMAGE',NULL,'{}','2026-10-25T22:59:59.999Z'),
    ('end','end-wa','a','pn','whatsapp',false,'TEXT','next day','{}','2026-10-25T23:00:00Z')
)`;
function query(args) {
  const sql = MESSAGE_BY_DATE_SQL.replace(/\$(\d+)/g, (_, n) => literal(args[Number(n) - 1]));
  const result = execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], {
    input: `BEGIN READ ONLY; ${fixtures} SELECT coalesce(json_agg(row),'[]'::json) FROM (${sql}) row; ROLLBACK;`, encoding:'utf8',
  });
  return JSON.parse(result.trim());
}
const range = ['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z'];
assert.deepEqual(query(['a',['pn','lid'],...range]), [{id:'first',wa_message_id:'first-wa'}]);
assert.deepEqual(query(['a',['pn'],...range]), [{id:'last',wa_message_id:'last-wa'}]);
assert.deepEqual(query(['missing',['pn','lid'],...range]), []);
assert.deepEqual(query(['a',['absent'],...range]), []);
console.log('PostgreSQL date lookup: local 25-hour day, aliases, boundaries, deleted/protocol/platform filtering and account/chat isolation pass');
