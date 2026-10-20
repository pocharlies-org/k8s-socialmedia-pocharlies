import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { DELETED_AT_SQL } from '../lib/chat-names.mjs';

const url = process.env.WHATSAPP_TEST_DATABASE_URL;
test('deleted timestamps pass the metadata instant through unchanged', {skip: !url}, async () => {
  assert.match(new URL(url).pathname, /^\/whatsapp_qa/);
  const db = new pg.Client({connectionString: url});
  await db.connect();
  try {
    await db.query('BEGIN');
    // El valor es texto ISO-UTC (backfill 015 / conector): la zona de la sesión no debe tocarlo.
    await db.query("SET LOCAL TIME ZONE 'Europe/Madrid'");
    await db.query('CREATE TEMP TABLE messages(metadata jsonb)');
    await db.query(
      `INSERT INTO pg_temp.messages VALUES ('{"deleted_at": "2026-10-11T09:20:00.000Z"}'::jsonb), ('{}'::jsonb), (NULL)`);
    const result = await db.query(`SELECT ${DELETED_AT_SQL} AS deleted FROM pg_temp.messages m`);
    assert.equal(new Date(result.rows[0].deleted).toISOString(), '2026-10-11T09:20:00.000Z');
    assert.equal(result.rows[1].deleted, null);
    assert.equal(result.rows[2].deleted, null);
  } finally { await db.query('ROLLBACK'); await db.end(); }
});
