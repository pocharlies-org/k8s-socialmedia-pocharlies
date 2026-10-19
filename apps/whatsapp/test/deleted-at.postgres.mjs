import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { DELETED_AT_SQL } from '../lib/chat-names.mjs';

const url = process.env.WHATSAPP_TEST_DATABASE_URL;
test('deleted timestamps retain the real instant for legacy UTC and timestamptz schemas', {skip: !url}, async () => {
  assert.match(new URL(url).pathname, /^\/whatsapp_qa/);
  const db = new pg.Client({connectionString: url});
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL TIME ZONE 'Europe/Madrid'");
    for (const type of ['timestamp without time zone', 'timestamptz']) {
      await db.query(`CREATE TEMP TABLE messages(deleted_at ${type})`);
      await db.query("INSERT INTO pg_temp.messages VALUES ('2026-10-11 09:20:00+00'),(NULL)");
      const result = await db.query(`SELECT ${DELETED_AT_SQL} AS deleted FROM pg_temp.messages m`);
      assert.equal(new Date(result.rows[0].deleted).toISOString(), '2026-10-11T09:20:00.000Z');
      assert.equal(result.rows[1].deleted, null);
      await db.query('DROP TABLE pg_temp.messages');
    }
  } finally { await db.query('ROLLBACK'); await db.end(); }
});
