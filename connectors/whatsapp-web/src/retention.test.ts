/**
 * Retention of whatsapp_send_attempts (7 days) and whatsapp_message_payloads
 * (DURABLE_PAYLOAD_RETENTION_DAYS, 90) — fase 3 / PR-2.
 *
 * No real DB: pg.Pool#query is stubbed. The SQL itself is validated against a
 * real Postgres 17 when the migration is (see the PR).
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { BaileysClient } from './baileys-client';
import {
  maybeRunRetention,
  payloadRetentionDays,
  statusRetentionDays,
  purgeSql,
  purgeTable,
  RETENTION_BATCH_SIZE,
  RETENTION_INTERVAL_MS,
  resetRetentionStateForTests,
  runRetention,
  sendAttemptRetentionDays,
} from './retention';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function stubPool(respond: (sql: string, params: unknown[]) => Promise<{ rowCount: number }>): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    return respond(sql, params).then(r => ({ rows: [], ...r }));
  };
  return {
    calls,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg.Pool.prototype as any).query = original;
    },
  };
}

function setEnv(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

test('purge SQL: batched by ctid, scoped to the account, parameterised age', () => {
  const sql = purgeSql('whatsapp_message_payloads').replace(/\s+/g, ' ');
  assert.match(
    sql,
    /^DELETE FROM whatsapp_message_payloads WHERE ctid IN \( SELECT ctid FROM whatsapp_message_payloads WHERE account = \$1 AND created_at < NOW\(\) - make_interval\(days => \$2\) LIMIT 5000\)$/
  );
  assert.match(purgeSql('whatsapp_send_attempts'), /DELETE FROM whatsapp_send_attempts/);
  // Statuses age by when they were posted, not when they were indexed (backfill).
  assert.match(
    purgeSql('whatsapp_statuses').replace(/\s+/g, ' '),
    /WHERE account = \$1 AND posted_at < NOW\(\) - make_interval\(days => \$2\)/
  );
  assert.equal(RETENTION_BATCH_SIZE, 5000);
});

test('retention windows: 7 days for send attempts, 90 for payloads, env-overridable', () => {
  const undo = [
    setEnv('WA_SEND_ATTEMPT_RETENTION_DAYS', undefined),
    setEnv('DURABLE_PAYLOAD_RETENTION_DAYS', undefined),
    setEnv('WA_STATUS_RETENTION_DAYS', undefined),
  ];
  try {
    assert.equal(statusRetentionDays(), 30);
    process.env.WA_STATUS_RETENTION_DAYS = '3';
    assert.equal(statusRetentionDays(), 3);
    assert.equal(sendAttemptRetentionDays(), 7);
    assert.equal(payloadRetentionDays(), 90);
    process.env.DURABLE_PAYLOAD_RETENTION_DAYS = '30';
    process.env.WA_SEND_ATTEMPT_RETENTION_DAYS = '2';
    assert.equal(payloadRetentionDays(), 30);
    assert.equal(sendAttemptRetentionDays(), 2);
    process.env.DURABLE_PAYLOAD_RETENTION_DAYS = 'nonsense';
    assert.equal(payloadRetentionDays(), 90);
  } finally {
    undo.reverse().forEach(fn => fn());
  }
});

test('purgeTable loops while batches are full and stops at a short one', async () => {
  const undo = setEnv('CONNECTOR_ACCOUNT', 'professional');
  const counts = [5000, 5000, 12];
  const { calls, restore } = stubPool(async () => ({ rowCount: counts.shift() ?? 0 }));
  try {
    assert.equal(await purgeTable('whatsapp_message_payloads', 90), 10012);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].params, ['professional', 90]);
  } finally {
    restore();
    undo();
  }
});

test('purgeTable is capped per run and 0 days disables it', async () => {
  const { calls, restore } = stubPool(async () => ({ rowCount: 5000 }));
  try {
    assert.equal(await purgeTable('whatsapp_message_payloads', 0), 0);
    assert.equal(calls.length, 0);
    assert.equal(await purgeTable('whatsapp_message_payloads', 90), 20 * 5000);
    assert.equal(calls.length, 20);
  } finally {
    restore();
  }
});

test('runRetention purges the three tables and tolerates a missing one (42P01)', async () => {
  const undo = [
    setEnv('CONNECTOR_ACCOUNT', 'personal'),
    setEnv('WA_SEND_ATTEMPT_RETENTION_DAYS', undefined),
    setEnv('DURABLE_PAYLOAD_RETENTION_DAYS', undefined),
    setEnv('WA_STATUS_RETENTION_DAYS', undefined),
  ];
  const { calls, restore } = stubPool(async sql => {
    if (/whatsapp_send_attempts/.test(sql)) {
      throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
    }
    return { rowCount: 3 };
  });
  try {
    await runRetention();
    assert.equal(calls.length, 3);
    assert.match(calls[0].sql, /whatsapp_send_attempts/);
    assert.deepEqual(calls[0].params, ['personal', 7]);
    assert.match(calls[1].sql, /whatsapp_message_payloads/);
    assert.deepEqual(calls[1].params, ['personal', 90]);
    assert.match(calls[2].sql, /DELETE FROM whatsapp_statuses/);
    assert.deepEqual(calls[2].params, ['personal', 30]);
  } finally {
    restore();
    undo.reverse().forEach(fn => fn());
  }
});

test('maybeRunRetention runs at most hourly and never overlaps', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => (release = resolve));
  const { calls, restore } = stubPool(async () => {
    await gate;
    return { rowCount: 0 };
  });
  try {
    resetRetentionStateForTests();
    const t0 = 1_000_000_000_000;
    const running = maybeRunRetention(t0);
    assert.ok(running);
    assert.equal(maybeRunRetention(t0 + RETENTION_INTERVAL_MS + 1), null, 'still running');
    release();
    await running;
    assert.equal(calls.length, 3);
    assert.equal(maybeRunRetention(t0 + 60_000), null, 'not due within the hour');
    const next = maybeRunRetention(t0 + RETENTION_INTERVAL_MS);
    assert.ok(next);
    await next;
    assert.equal(calls.length, 6);
  } finally {
    restore();
  }
});

test('ingest off: BaileysClient never starts a purge', async () => {
  const { calls, restore } = stubPool(async () => ({ rowCount: 0 }));
  try {
    resetRetentionStateForTests(); // a purge would be due right now
    const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), { ingest: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).persistDurablePayload(
      { key: { id: 'X', remoteJid: '1@s.whatsapp.net' }, message: { conversation: 'x' } },
      '1@s.whatsapp.net',
      'live'
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 0);
  } finally {
    restore();
    resetRetentionStateForTests();
  }
});

test('ingest on: the ingest path starts the hourly purge', async () => {
  const { calls, restore } = stubPool(async () => ({ rowCount: 0 }));
  try {
    resetRetentionStateForTests();
    const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).persistDurablePayload(
      { key: { id: 'X', remoteJid: '1@s.whatsapp.net' }, message: { conversation: 'x' } },
      '1@s.whatsapp.net',
      'live'
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(calls.some(c => /DELETE FROM whatsapp_send_attempts/.test(c.sql)));
    assert.ok(calls.some(c => /DELETE FROM whatsapp_message_payloads/.test(c.sql)));
  } finally {
    restore();
  }
});
