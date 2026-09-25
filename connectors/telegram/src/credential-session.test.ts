/**
 * SC-1145: telegram connector wiring to the per-user credential store,
 * specced against a fake store (node:test, run through the connector's
 * `pnpm test` — same harness as the whatsapp-web credential-session spec).
 * Covers: session_key convention per sub, resolver precedence through the
 * mtcute adapter, encrypted round-trip via PostgresCredentialStore + fake
 * pool, persist write-back choreography, logout delete, and the zero-change
 * legacy path with the flag off / the house accounts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MemoryStorage } from '@mtcute/node';
import type { Pool } from 'pg';
import type { CredentialChannel, CredentialStore, StoredCredential } from '@mcp-socialmedia/shared';
import {
  PostgresCredentialStore,
  credentialSessionKeyFromEnv,
  deserializeMtcuteSession,
  serializeMtcuteSession,
} from '@mcp-socialmedia/shared';
import {
  createTelegramCredentialWriteBack,
  isSessionInvalidatedError,
  resolveTelegramSession,
} from './credential-session';
import {
  HookedMemoryStorageDriver,
  PersistHookedStorage,
  createTelegramStorage,
} from './telegram-client';

class FakeStore implements CredentialStore {
  rows = new Map<string, StoredCredential>();
  getCalls = 0;
  puts: { key: string; channel: CredentialChannel; payload: Record<string, unknown> }[] = [];
  deletes: { key: string; channel: CredentialChannel }[] = [];
  putError: Error | null = null;

  async get(sessionKey: string, channel: CredentialChannel): Promise<StoredCredential | null> {
    this.getCalls++;
    return this.rows.get(`${sessionKey}/${channel}`) ?? null;
  }
  async put(
    sessionKey: string,
    channel: CredentialChannel,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (this.putError) throw this.putError;
    this.puts.push({ key: sessionKey, channel, payload });
    this.rows.set(`${sessionKey}/${channel}`, {
      sessionKey,
      channel,
      payload,
      updatedAt: new Date(),
    });
  }
  async delete(sessionKey: string, channel: CredentialChannel): Promise<void> {
    this.deletes.push({ key: sessionKey, channel });
    this.rows.delete(`${sessionKey}/${channel}`);
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const SUB_A = 'e51253a7-9e1b-4f4a-9a1d-0f2b3c4d5e6f';
const SUB_B = '7a9c1d3e-5b7f-4a2c-8e0d-1f3a5b7c9d0e';

// ---------------------------------------------------------------------------
// session_key convention (shared mechanism — the house stays inadoptable)
// ---------------------------------------------------------------------------

test('credentialSessionKeyFromEnv: flag off or key unset → null (legacy path, house inadoptable)', () => {
  assert.equal(credentialSessionKeyFromEnv({}), null);
  assert.equal(credentialSessionKeyFromEnv({ CREDENTIAL_STORE_ENABLED: 'true' }), null);
  assert.equal(
    credentialSessionKeyFromEnv({
      CREDENTIAL_STORE_ENABLED: 'false',
      CREDENTIAL_SESSION_KEY: SUB_A,
    }),
    null
  );
});

test('credentialSessionKeyFromEnv: sub and sub:account accepted, traversal rejected', () => {
  const env = { CREDENTIAL_STORE_ENABLED: 'true' };
  assert.equal(credentialSessionKeyFromEnv({ ...env, CREDENTIAL_SESSION_KEY: SUB_A }), SUB_A);
  assert.equal(
    credentialSessionKeyFromEnv({ ...env, CREDENTIAL_SESSION_KEY: `${SUB_A}:professional` }),
    `${SUB_A}:professional`
  );
  assert.throws(
    () => credentialSessionKeyFromEnv({ ...env, CREDENTIAL_SESSION_KEY: '../../etc' }),
    /CREDENTIAL_SESSION_KEY/
  );
  assert.throws(() => credentialSessionKeyFromEnv({ ...env, CREDENTIAL_SESSION_KEY: 'a/b' }), /CREDENTIAL_SESSION_KEY/);
});

// ---------------------------------------------------------------------------
// resolution through resolveCredential + the mtcute adapter
// ---------------------------------------------------------------------------

test('resolveTelegramSession: stored row wins over the env session', async () => {
  const store = new FakeStore();
  store.rows.set(`${SUB_A}/telegram`, {
    sessionKey: SUB_A,
    channel: 'telegram',
    payload: { ...serializeMtcuteSession('ROW-SESSION') },
    updatedAt: new Date(),
  });
  const resolved = await resolveTelegramSession(store, SUB_A, 'ENV-SESSION', {
    enabled: true,
    log: () => {},
  });
  assert.deepEqual(resolved, { sessionString: 'ROW-SESSION', source: 'store', adopted: false });
  // Row-first: loadLegacy must never have run, so nothing was written.
  assert.equal(store.puts.length, 0);
});

test('resolveTelegramSession: no row + env session → adopted into a row keyed by the sub', async () => {
  const store = new FakeStore();
  const resolved = await resolveTelegramSession(store, SUB_A, '  ENV-SESSION  ', {
    enabled: true,
    log: () => {},
  });
  assert.deepEqual(resolved, { sessionString: 'ENV-SESSION', source: 'legacy', adopted: true });
  assert.equal(store.puts.length, 1);
  assert.equal(store.puts[0].key, SUB_A);
  assert.equal(store.puts[0].channel, 'telegram');
  assert.deepEqual(store.puts[0].payload, { sessionString: 'ENV-SESSION' });
});

test('resolveTelegramSession: no row and no env → null session (pairing gesture pending)', async () => {
  const store = new FakeStore();
  const resolved = await resolveTelegramSession(store, SUB_A, '', { enabled: true, log: () => {} });
  assert.equal(resolved.sessionString, null);
  assert.equal(store.puts.length, 0);
});

test('resolveTelegramSession: flag OFF → exact legacy path, zero store reads and writes', async () => {
  const store = new FakeStore();
  store.rows.set(`${SUB_A}/telegram`, {
    sessionKey: SUB_A,
    channel: 'telegram',
    payload: { ...serializeMtcuteSession('ROW-SESSION') },
    updatedAt: new Date(),
  });
  const resolved = await resolveTelegramSession(store, SUB_A, 'ENV-SESSION', {
    enabled: false,
    log: () => {},
  });
  assert.deepEqual(resolved, { sessionString: 'ENV-SESSION', source: 'legacy', adopted: false });
  assert.equal(store.getCalls, 0);
  assert.equal(store.puts.length, 0);
});

test('resolveTelegramSession: two subs keep two isolated rows', async () => {
  const store = new FakeStore();
  await resolveTelegramSession(store, SUB_A, 'SESSION-A', { enabled: true, log: () => {} });
  await resolveTelegramSession(store, SUB_B, 'SESSION-B', { enabled: true, log: () => {} });
  const a = await resolveTelegramSession(store, SUB_A, 'IGNORED-ENV', { enabled: true, log: () => {} });
  const b = await resolveTelegramSession(store, SUB_B, 'IGNORED-ENV', { enabled: true, log: () => {} });
  assert.equal(a.sessionString, 'SESSION-A');
  assert.equal(b.sessionString, 'SESSION-B');
  assert.equal(a.source, 'store');
  assert.equal(b.source, 'store');
});

// ---------------------------------------------------------------------------
// encrypted round-trip through the real store class (fake pool)
// ---------------------------------------------------------------------------

class FakePool {
  rows = new Map<string, { session_key: string; channel: string; payload: unknown; updated_at: Date }>();
  queries: { sql: string; params: unknown[] }[] = [];
  async query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push({ sql, params });
    const key = `${params[0]}/${params[1]}`;
    if (sql.trimStart().startsWith('SELECT')) {
      const row = this.rows.get(key);
      return { rows: row ? [row] : [] };
    }
    if (sql.trimStart().startsWith('INSERT')) {
      this.rows.set(key, {
        session_key: params[0] as string,
        channel: params[1] as string,
        payload: JSON.parse(params[2] as string),
        updated_at: new Date(),
      });
    }
    if (sql.trimStart().startsWith('DELETE')) this.rows.delete(key);
    return { rows: [] };
  }
}

test('PostgresCredentialStore round-trip: the DB holds only the envelope, get decrypts to the session', async () => {
  const pool = new FakePool();
  const store = new PostgresCredentialStore(pool as unknown as Pool, {
    masterKey: randomBytes(32),
  });
  const SESSION = '1.234.567.aabbccdd-telegram-session-string';
  await store.put(SUB_A, 'telegram', { ...serializeMtcuteSession(SESSION) });

  // session_key per sub + channel telegram in the SQL params.
  const insert = pool.queries.find(q => q.sql.trimStart().startsWith('INSERT'));
  assert.deepEqual(insert?.params.slice(0, 2), [SUB_A, 'telegram']);
  // The stored jsonb is the v1 envelope and never the plaintext session.
  const stored = pool.rows.get(`${SUB_A}/telegram`)?.payload as Record<string, unknown>;
  assert.equal(stored.enc, 'v1');
  assert.equal(typeof stored.ct, 'string');
  assert.ok(!JSON.stringify(pool.rows.get(`${SUB_A}/telegram`)).includes(SESSION));

  const row = await store.get(SUB_A, 'telegram');
  assert.ok(row);
  assert.equal(deserializeMtcuteSession(row.payload).sessionString, SESSION);
});

test('PostgresCredentialStore without master key fails closed on put', async () => {
  const pool = new FakePool();
  const store = new PostgresCredentialStore(pool as unknown as Pool, { masterKey: null });
  await assert.rejects(
    () => store.put(SUB_A, 'telegram', { ...serializeMtcuteSession('x') }),
    /CREDENTIAL_STORE_MASTER_KEY/
  );
});

// ---------------------------------------------------------------------------
// persist → write-back choreography (the baileys saveCreds counterpart)
// ---------------------------------------------------------------------------

test('write-back: coalesces bursts, lands the latest session, flush is deterministic', async () => {
  const store = new FakeStore();
  let current = 'S1';
  const wb = createTelegramCredentialWriteBack(store, SUB_A, async () => current, () => {}, 10);
  wb.schedule();
  wb.schedule();
  wb.schedule();
  current = 'S2';
  await wb.flush();
  assert.equal(store.puts.length, 1);
  assert.equal(store.puts[0].key, SUB_A);
  assert.equal(store.puts[0].channel, 'telegram');
  assert.deepEqual(store.puts[0].payload, { sessionString: 'S2' });

  // A persist while a put is in flight must still reach the store (trailing run).
  current = 'S3';
  wb.schedule();
  await sleep(15); // debounce fires, put starts
  current = 'S4';
  wb.schedule();
  await wb.flush();
  const last = store.puts[store.puts.length - 1];
  assert.deepEqual(last.payload, { sessionString: 'S4' });
});

test('write-back: a store failure logs loudly and never throws into the hook', async () => {
  const store = new FakeStore();
  store.putError = new Error('db down');
  const errors: string[] = [];
  const wb = createTelegramCredentialWriteBack(store, SUB_A, async () => 'S1', m => errors.push(m), 1);
  wb.schedule();
  await sleep(10);
  await wb.flush();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /write-back FAILED.*db down/);
});

test('write-back: cancel() drops a scheduled write (logout must not re-put a dead session)', async () => {
  const store = new FakeStore();
  const wb = createTelegramCredentialWriteBack(store, SUB_A, async () => 'DEAD', () => {}, 5);
  wb.schedule();
  wb.cancel();
  await wb.flush();
  await sleep(20);
  assert.equal(store.puts.length, 0);
});

// ---------------------------------------------------------------------------
// logout detection
// ---------------------------------------------------------------------------

test('isSessionInvalidatedError: revoked/expired sessions true, everything else false', () => {
  const rpc = (text: string) => Object.assign(new Error(text), { name: 'RpcError', text });
  assert.ok(isSessionInvalidatedError(rpc('AUTH_KEY_UNREGISTERED')));
  assert.ok(isSessionInvalidatedError(rpc('SESSION_REVOKED')));
  assert.ok(isSessionInvalidatedError(rpc('USER_DEACTIVATED_BAN')));
  // start() swallows the RpcError and then demands a phone — with a session
  // already passed in, that fall-through means the credential was dead.
  assert.ok(
    isSessionInvalidatedError(
      Object.assign(new Error('Neither phone nor bot token were provided'), {
        name: 'MtArgumentError',
      })
    )
  );
  // A malformed session string is an operator problem, not a dead credential.
  assert.ok(!isSessionInvalidatedError(
    Object.assign(new Error('Invalid session string'), { name: 'MtArgumentError' })
  ));
  assert.ok(!isSessionInvalidatedError(rpc('FLOOD_WAIT_42')));
  assert.ok(!isSessionInvalidatedError(new Error('network timeout')));
  assert.ok(!isSessionInvalidatedError(null));
});

// ---------------------------------------------------------------------------
// the mtcute persist hook itself
// ---------------------------------------------------------------------------

test('createTelegramStorage: no credentialSessionKey → plain MemoryStorage (house path untouched)', () => {
  let fired = 0;
  for (const key of [undefined, null, '']) {
    const storage = createTelegramStorage(key, () => fired++);
    assert.ok(storage instanceof MemoryStorage);
    assert.ok(!(storage instanceof PersistHookedStorage));
    assert.equal(storage.driver.constructor.name, 'MemoryStorageDriver');
    assert.equal((storage.driver as { save?: unknown }).save, undefined);
  }
  assert.equal(fired, 0);
});

test('createTelegramStorage: with credentialSessionKey → driver.save() fires the persist hook', async () => {
  let fired = 0;
  const storage = createTelegramStorage('sub-a', () => fired++);
  assert.ok(storage instanceof PersistHookedStorage);
  assert.ok(storage.driver instanceof HookedMemoryStorageDriver);
  // StorageManager.save() reaches the driver exactly this way.
  await storage.driver.save?.();
  await storage.driver.save?.();
  assert.equal(fired, 2);
});

test('PersistHookedStorage: every repository is built on the hooked driver and keeps working', () => {
  const storage = new PersistHookedStorage(() => {});
  for (const repo of [storage.kv, storage.authKeys, storage.peers, storage.refMessages]) {
    assert.equal(repo._driver, storage.driver);
  }
  const key = new Uint8Array([1, 2, 3]);
  storage.authKeys.set(2, key);
  assert.deepEqual(storage.authKeys.get(2), key);
  storage.kv.set('k', new Uint8Array([9]));
  assert.deepEqual(storage.kv.get('k'), new Uint8Array([9]));
});
