import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { utcDatabaseTypes } from '../lib/database-time.mjs';

test('UTC message timestamps keep their instant across app container timezones and DST', () => {
  const moduleUrl = new URL('../lib/database-time.mjs', import.meta.url).href;
  const pgUrl = import.meta.resolve('pg');
  const script = `
    import pg from ${JSON.stringify(pgUrl)};
    import { utcDatabaseTypes } from ${JSON.stringify(moduleUrl)};
    const client = new pg.Client({ types: utcDatabaseTypes() });
    const decode = client._types.getTypeParser(1114, 'text');
    console.log(JSON.stringify([
      '2026-09-23 18:52:00', '2026-01-23 18:52:00',
      '2026-03-29 01:30:00', '2026-10-25 01:30:00',
      '2026-09-23 18:52:00.123456'
    ].map(value => decode(value).toISOString())));
  `;
  for (const TZ of ['UTC', 'Europe/Madrid', 'America/New_York', 'Asia/Kolkata']) {
    const values = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' }));
    assert.deepEqual(values, [
      '2026-09-23T18:52:00.000Z', '2026-01-23T18:52:00.000Z',
      '2026-03-29T01:30:00.000Z', '2026-10-25T01:30:00.000Z',
      '2026-09-23T18:52:00.123Z',
    ], TZ);
  }
});

test('pool overrides leave global parsers, zoned timestamps and other database types unchanged', () => {
  const original = pg.types.getTypeParser(1114);
  const types = utcDatabaseTypes();
  assert.equal(pg.types.getTypeParser(1114), original);
  for (const oid of [25, 23, 1184, 1082]) assert.equal(types.getTypeParser(oid), pg.types.getTypeParser(oid));
  assert.equal(types.getTypeParser(1114, 'binary'), pg.types.getTypeParser(1114, 'binary'));
  assert.equal(types.getTypeParser(1114)('infinity'), Infinity);
  assert.equal(types.getTypeParser(1114)('-infinity'), -Infinity);
  assert.equal(types.getTypeParser(1184)('2026-09-23 20:52:00+02').toISOString(), '2026-09-23T18:52:00.000Z');
});
