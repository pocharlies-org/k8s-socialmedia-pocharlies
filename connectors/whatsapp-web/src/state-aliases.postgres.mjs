// DATABASE_URL is required. All fixtures live in one connection and roll back.
import assert from 'node:assert/strict';
import pg from 'pg';
import { setConversationState } from './db-writer.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
process.env.CONNECTOR_ACCOUNT = 'professional';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const originalQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (sql, params) { return client.query(sql, params); };
try {
  await client.query('BEGIN');
  await client.query(`
    CREATE TEMP TABLE conversations (
      id text PRIMARY KEY, account text, wa_chat_id text, is_group boolean DEFAULT false,
      unread_count integer DEFAULT 0, archived boolean DEFAULT false,
      updated_at timestamptz DEFAULT now()
    );
    INSERT INTO conversations (id,account,wa_chat_id,unread_count,archived) VALUES
      ('professional:777@lid','professional','professional:34600123456@s.whatsapp.net',1,true),
      ('professional:34600123456@c.us','professional',NULL,3,true),
      ('professional:34600123456@s.whatsapp.net','professional',NULL,4,true),
      ('personal:34600123456@c.us','personal',NULL,9,true),
      ('professional:999@lid','professional',NULL,5,true);
  `);
  const state = async id => (await client.query('SELECT unread_count, archived FROM conversations WHERE id=$1', [id])).rows[0];
  await setConversationState('34600123456@c.us', 0, false);
  for (const id of ['professional:777@lid', 'professional:34600123456@c.us', 'professional:34600123456@s.whatsapp.net']) {
    assert.deepEqual(await state(id), { unread_count: 0, archived: false });
  }
  assert.deepEqual(await state('personal:34600123456@c.us'), { unread_count: 9, archived: true });
  assert.deepEqual(await state('professional:999@lid'), { unread_count: 5, archived: true });

  await setConversationState('777@lid', 2, true);
  assert.deepEqual(await state('professional:777@lid'), { unread_count: 2, archived: true });
  for (const id of ['professional:34600123456@c.us', 'professional:34600123456@s.whatsapp.net']) {
    assert.deepEqual(await state(id), { unread_count: 0, archived: true });
  }

  await client.query(`
    INSERT INTO conversations (id,account,wa_chat_id,unread_count,archived) VALUES
      ('professional:888@lid','professional','professional:34700123456@s.whatsapp.net',2,true),
      ('professional:889@lid','professional','professional:34700123456@c.us',3,true),
      ('professional:34700123456@c.us','professional',NULL,4,true);
  `);
  await setConversationState('888@lid', 0, false);
  assert.deepEqual(await state('professional:888@lid'), { unread_count: 0, archived: false });
  assert.deepEqual(await state('professional:889@lid'), { unread_count: 3, archived: true });
  assert.deepEqual(await state('professional:34700123456@c.us'), { unread_count: 4, archived: true });
  console.log('PostgreSQL state aliases: PN variants, account isolation, ambiguous LID passed');
} finally {
  pg.Pool.prototype.query = originalQuery;
  await client.query('ROLLBACK');
  await client.end();
}
