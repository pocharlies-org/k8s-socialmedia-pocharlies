/**
 * SC-552 integration tests for PostgresCredentialStore against a real
 * Postgres. The repo's jest harness has no DB by default (all other specs run
 * on fakes), so this suite runs ONLY when CREDSTORE_TEST_DATABASE_URL points
 * at a reachable test database, and is skipped otherwise — CI without a DB
 * stays green and simply does not exercise these.
 *
 * Local ephemeral DB used for the PR evidence:
 *   docker run -d --name sc552-credstore-test -p 55432:5432 \
 *     -e POSTGRES_USER=credtest -e POSTGRES_PASSWORD=credtest \
 *     -e POSTGRES_DB=credstore_test postgres:16-alpine
 *   CREDSTORE_TEST_DATABASE_URL=postgresql://credtest:credtest@localhost:55432/credstore_test \
 *     pnpm --filter @mcp-socialmedia/server test credential-store.postgres
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresCredentialStore } from './credential-store';
import { resolveCredential } from './credential-resolver';

const TEST_DATABASE_URL = process.env.CREDSTORE_TEST_DATABASE_URL || '';
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const MIGRATION_007 = join(
  __dirname,
  '..',
  'database',
  'migrations',
  '007_user_channel_credentials.sql'
);

describeDb('SC-552 PostgresCredentialStore (real Postgres)', () => {
  let pool: Pool;
  let store: PostgresCredentialStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query(readFileSync(MIGRATION_007, 'utf-8'));
    store = new PostgresCredentialStore(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  test('put/get round-trips an opaque channel payload', async () => {
    const key = `test-${randomUUID()}`;
    await store.put(key, 'whatsapp', { files: { 'creds.json': 'e30=' } });

    const row = await store.get(key, 'whatsapp');
    expect(row?.payload).toEqual({ files: { 'creds.json': 'e30=' } });
    expect(row?.sessionKey).toBe(key);
    expect(row?.channel).toBe('whatsapp');
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  test('channels are isolated per key and put upserts', async () => {
    const key = `test-${randomUUID()}`;
    await store.put(key, 'telegram', { sessionString: 'one' });
    await store.put(key, 'telegram', { sessionString: 'two' });

    expect((await store.get(key, 'telegram'))?.payload).toEqual({ sessionString: 'two' });
    expect(await store.get(key, 'whatsapp')).toBeNull();
    expect(await store.get(`test-${randomUUID()}`, 'telegram')).toBeNull();
  });

  test('resolve: no header → exact legacy path, ZERO rows written', async () => {
    const key = `test-${randomUUID()}`;
    const result = await resolveCredential({
      store,
      actor: {},
      channel: 'whatsapp',
      loadLegacy: async () => ({ files: { 'creds.json': 'bGVnYWN5' } }),
      enabled: true,
    });

    expect(result).toEqual({
      payload: { files: { 'creds.json': 'bGVnYWN5' } },
      source: 'legacy',
      adopted: false,
    });
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM user_channel_credentials WHERE session_key = $1',
      [key]
    );
    expect(count.rows[0].n).toBe(0);
  });

  test('resolve: header without row → row created from legacy (adopt), legacy served', async () => {
    const key = `test-${randomUUID()}`;
    const legacy = { sessionString: 'adopted-session' };
    const result = await resolveCredential({
      store,
      actor: { sub: key },
      channel: 'telegram',
      loadLegacy: async () => legacy,
      enabled: true,
    });

    expect(result).toEqual({ payload: legacy, source: 'legacy', adopted: true });
    const inDb = await pool.query(
      'SELECT payload FROM user_channel_credentials WHERE session_key = $1 AND channel = $2',
      [key, 'telegram']
    );
    expect(inDb.rows[0]?.payload).toEqual(legacy);
  });

  test('resolve: header with row → the row wins over legacy', async () => {
    const key = `test-${randomUUID()}`;
    await store.put(key, 'instagram', { accessToken: 'row-token', businessAccountId: '1' });

    const result = await resolveCredential({
      store,
      actor: { sub: key },
      channel: 'instagram',
      loadLegacy: async () => ({ accessToken: 'legacy-token', businessAccountId: '1' }),
      enabled: true,
    });

    expect(result.source).toBe('store');
    expect(result.payload).toEqual({ accessToken: 'row-token', businessAccountId: '1' });
  });

  test('persistence: a row survives a process restart (fresh Pool + store instance)', async () => {
    const key = `test-${randomUUID()}`;
    await store.put(key, 'whatsapp', { files: { 'session-1': 'AAEC' } });

    // Simulate a gateway/pod restart: a brand-new connection pool and store,
    // reading the same database.
    const restartedPool = new Pool({ connectionString: TEST_DATABASE_URL });
    try {
      const restartedStore = new PostgresCredentialStore(restartedPool);
      const row = await restartedStore.get(key, 'whatsapp');
      expect(row?.payload).toEqual({ files: { 'session-1': 'AAEC' } });
    } finally {
      await restartedPool.end();
    }
  });
});
