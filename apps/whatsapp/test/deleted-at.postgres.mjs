import test from 'node:test';
import assert from 'node:assert/strict';
import { DELETED_AT_SQL } from '../lib/chat-names.mjs';
import { connectDisposableDatabase } from './postgres-fixture.mjs';

const url = process.env.WHATSAPP_TEST_DATABASE_URL;
test('deleted timestamps retain the real instant for legacy UTC and timestamptz schemas', {skip: !url}, async () => {
  const db = await connectDisposableDatabase(url);
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL TIME ZONE 'Europe/Madrid'");
    for (const type of ['timestamp without time zone', 'timestamptz']) {
      await db.query(`CREATE TEMP TABLE messages(id uuid, metadata jsonb DEFAULT '{}', deleted_at ${type})`);
      await db.query("INSERT INTO pg_temp.messages(deleted_at) VALUES ('2026-10-11 09:20:00+00'),(NULL)");
      const result = await db.query(`SELECT ${DELETED_AT_SQL} AS deleted FROM pg_temp.messages m`);
      assert.equal(new Date(result.rows[0].deleted).toISOString(), '2026-10-11T09:20:00.000Z');
      assert.equal(result.rows[1].deleted, null);
      await db.query(`UPDATE pg_temp.messages SET metadata='{"deleted_at":"2026-10-10T11:20:00+02:00"}'
        WHERE deleted_at IS NOT NULL`);
      assert.equal((await db.query(`SELECT ${DELETED_AT_SQL} AS deleted FROM pg_temp.messages m
        WHERE deleted_at IS NOT NULL`)).rows[0].deleted, '2026-10-10T09:20:00.000000Z');
      await db.query(`UPDATE pg_temp.messages SET metadata='{"deleted_at":"2026-02-30T09:20:00Z"}'
        WHERE deleted_at IS NOT NULL`);
      assert.equal((await db.query(`SELECT ${DELETED_AT_SQL} AS deleted FROM pg_temp.messages m
        WHERE deleted_at IS NOT NULL`)).rows[0].deleted, '2026-10-11T09:20:00.000000Z');
      await db.query('DROP TABLE pg_temp.messages');
    }
    await db.query('CREATE TEMP TABLE messages(id bigint, metadata jsonb)');
    const cases = [
      [{deleted_at: '2026-10-11T11:20:00+02:00'}, '2026-10-11T09:20:00.000000Z'],
      [{deleted_at: '2026-10-11 09:20:00.123456'}, '2026-10-11T09:20:00.123456Z'],
      [{deleted_at: '2026-02-30T09:20:00Z'}, null],
      [{deleted_at: 'invalid'}, null],
      [{deleted_at: ''}, null],
      [{deleted_at: 'infinity'}, null],
      [{deleted_at: 123}, null],
      [{deleted_at: null}, null],
      [{}, null],
      [null, null],
    ];
    for (const [index, [metadata, expected]] of cases.entries()) {
      await db.query('INSERT INTO pg_temp.messages VALUES($1,$2)', [index + 1, metadata]);
      assert.equal((await db.query(`SELECT ${DELETED_AT_SQL} AS deleted FROM pg_temp.messages m
        WHERE id=$1`, [index + 1])).rows[0].deleted, expected);
    }
  } finally { await db.query('ROLLBACK'); await db.end(); }
});
