import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { applyArchiveSnapshot } from './db-writer';

test('archive snapshot scopes updates, resolves aliases and creates missing groups', async () => {
  const prior = process.env.CONNECTOR_ACCOUNT;
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const original = pg.Pool.prototype.connect;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let released = false;
  (pg.Pool.prototype as any).connect = async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  });
  try {
    const result = await applyArchiveSnapshot([
      { jid: '123@s.whatsapp.net', aliases: ['456@lid'], archived: true, name: 'Persona' },
      { jid: '789@g.us', archived: true, name: 'Grupo' },
      { jid: '111@s.whatsapp.net', archived: false },
    ], new Date('2026-09-23T10:00:00Z'));
    assert.equal(result.archived, 2);
    assert.equal(calls[0].sql, 'BEGIN');
    assert.equal(calls.at(-1)?.sql, 'COMMIT');
    assert.equal(released, true);
    const reset = calls.find(c => c.sql.includes('SET archived = false'))!;
    assert.equal(reset.params[0], 'professional');
    assert.match(reset.sql, /updated_at <= \$2/);
    assert.match(reset.sql, /id <> ALL/);
    assert.ok((reset.params[2] as string[]).includes('professional:789@g.us'));
    const update = calls.find(c => c.sql.includes('SET archived = true'))!;
    assert.deepEqual(update.params[1], [
      'professional:123@s.whatsapp.net', 'professional:123@c.us', 'professional:456@lid',
      '123@s.whatsapp.net', '123@c.us', '456@lid',
    ]);
    assert.match(update.sql, /wa_chat_id = ANY/);
    const inserts = calls.filter(c => c.sql.includes('INSERT INTO conversations'));
    assert.deepEqual(inserts.map(c => c.params[0]), ['professional:123@c.us', 'professional:789@g.us']);
    assert.equal(inserts[1].params[5], true);
    assert.equal(inserts[0].params[5], false);
  } finally {
    (pg.Pool.prototype as any).connect = original;
    if (prior == null) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = prior;
  }
});

test('archive snapshot rolls back on a failed write', async () => {
  const prior = process.env.CONNECTOR_ACCOUNT;
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const original = pg.Pool.prototype.connect;
  const queries: string[] = [];
  (pg.Pool.prototype as any).connect = async () => ({
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SET archived = true')) throw new Error('write failed');
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  });
  try {
    await assert.rejects(applyArchiveSnapshot([
      { jid: '123@g.us', archived: true },
    ], new Date()), /write failed/);
    assert.equal(queries.at(-1), 'ROLLBACK');
  } finally {
    (pg.Pool.prototype as any).connect = original;
    if (prior == null) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = prior;
  }
});

test('updates an existing placeholder group title but keeps a useful title', async () => {
  const prior = process.env.CONNECTOR_ACCOUNT;
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const original = pg.Pool.prototype.connect;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  (pg.Pool.prototype as any).connect = async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: sql.includes('SET archived = true') ? 1 : 0 };
    },
    release: () => {},
  });
  try {
    await applyArchiveSnapshot([
      { jid: '123@g.us', archived: true, name: 'Real group' },
    ], new Date());
    const rename = calls.find(call => call.sql.includes('SET name = $3'))!;
    assert.equal(rename.params[2], 'Real group');
    assert.match(rename.sql, /name = id/);
    assert.match(rename.sql, /name = regexp_replace/);
    assert.match(rename.sql, /name ~ '@/);
    assert.equal(calls.some(call => call.sql.includes('INSERT INTO conversations')), false);
  } finally {
    (pg.Pool.prototype as any).connect = original;
    if (prior == null) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = prior;
  }
});
