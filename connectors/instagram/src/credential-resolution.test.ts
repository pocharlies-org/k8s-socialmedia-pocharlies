/**
 * SC-1194 P1 (SC-1143) criteria 3 and 4: per-sub credential resolution in the
 * instagram connector, with the store and Meta mocked.
 *
 * The isolation criterion is proven with the synthetic sub `pm-test-sin-fila`
 * (no row anywhere): the connector must answer the explicit
 * `no instagram credential for this user` error and must NEVER fall back to
 * another user's row or to the house env accounts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CredentialChannel, CredentialStore, StoredCredential } from '@mcp-socialmedia/shared';
import { InstagramAPI } from './instagram-api';
import { createInstagramCredentialStore, resolveInstagramEntry } from './credential-resolution';
import { IG_MIN_LONG_LIVED_EXPIRES_IN, PairingFetch } from './oauth-pairing';

class FakeStore implements CredentialStore {
  rows = new Map<string, StoredCredential>();
  puts: { key: string; payload: Record<string, unknown> }[] = [];
  reads = 0;

  seed(key: string, payload: Record<string, unknown>): void {
    this.rows.set(`${key}/instagram`, {
      sessionKey: key,
      channel: 'instagram',
      payload: payload as StoredCredential['payload'],
      updatedAt: new Date(),
    });
  }
  async get(sessionKey: string, channel: CredentialChannel): Promise<StoredCredential | null> {
    this.reads++;
    return this.rows.get(`${sessionKey}/${channel}`) ?? null;
  }
  async put(
    sessionKey: string,
    channel: CredentialChannel,
    payload: Record<string, unknown>
  ): Promise<void> {
    this.puts.push({ key: sessionKey, payload });
    this.rows.set(`${sessionKey}/${channel}`, {
      sessionKey,
      channel,
      payload: payload as StoredCredential['payload'],
      updatedAt: new Date(),
    });
  }
  async delete(sessionKey: string, channel: CredentialChannel): Promise<void> {
    this.rows.delete(`${sessionKey}/${channel}`);
  }
}

function houseAccount(name: string, token: string) {
  const api = new InstagramAPI({ accessToken: token, businessAccountId: `house-${name}` });
  return { name, api, config: { accessToken: token, businessAccountId: `house-${name}` } };
}

const DAY = 24 * 3600 * 1000;
function pairedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    accessToken: 'EAAL-user-token',
    businessAccountId: '17841444094675941',
    username: 'mi_cuenta',
    issuedAt: now - 3 * DAY,
    expiresAt: now + 57 * DAY,
    ...overrides,
  };
}

function okFetch(body: unknown): PairingFetch {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function servedToken(entry: { entry: { api: InstagramAPI } } | unknown): string {
  const api = (entry as { entry: { api: InstagramAPI } }).entry.api as unknown as {
    config: { accessToken: string };
  };
  return api.config.accessToken;
}

// ── flag OFF / anonymous: exact legacy path ──────────────────────────────

test('store disabled: legacy env account, zero store access', async () => {
  const store = new FakeStore();
  const house = houseAccount('skirmshop', 'HOUSE-TOKEN');
  const resolution = await resolveInstagramEntry({
    headers: { 'x-user-sub': 'daniel-sub' },
    accountName: 'skirmshop',
    store: null, // flag off — main.ts passes null
    legacyLookup: name => (name === 'skirmshop' ? house : undefined),
  });
  assert.equal(servedToken(resolution), 'HOUSE-TOKEN');
  assert.equal(store.reads, 0);
});

test('flag ON but anonymous caller: legacy env account, zero store reads', async () => {
  const store = new FakeStore();
  store.seed('daniel-sub', pairedPayload());
  const house = houseAccount('skirmshop', 'HOUSE-TOKEN');
  const resolution = await resolveInstagramEntry({
    headers: {},
    accountName: 'skirmshop',
    store,
    legacyLookup: name => (name === 'skirmshop' ? house : undefined),
  });
  assert.equal(servedToken(resolution), 'HOUSE-TOKEN');
  assert.equal(store.reads, 0, 'no sub → the resolver must not touch the store');
});

test('legacy unknown account keeps the 404-shaped error', async () => {
  const resolution = await resolveInstagramEntry({
    headers: {},
    accountName: 'nope',
    store: null,
    legacyLookup: () => undefined,
  });
  assert.ok('error' in resolution);
  assert.equal((resolution as { error: { code: string } }).error.code, 'unknown_account');
});

// ── flag ON + verified sub: the sub's own row wins ───────────────────────

test('sub with a row is served its own token, never the house one', async () => {
  const store = new FakeStore();
  store.seed('daniel-sub', pairedPayload());
  const house = houseAccount('skirmshop', 'HOUSE-TOKEN');
  const resolution = await resolveInstagramEntry({
    headers: { 'x-user-sub': 'daniel-sub' },
    accountName: 'skirmshop',
    store,
    legacyLookup: () => house,
  });
  assert.equal(servedToken(resolution), 'EAAL-user-token');
});

test('sub:account row takes precedence over the primary sub row', async () => {
  const store = new FakeStore();
  store.seed('daniel-sub', pairedPayload({ accessToken: 'PRIMARY' }));
  store.seed('daniel-sub:negocio', pairedPayload({ accessToken: 'SCOPED' }));
  const resolution = await resolveInstagramEntry({
    headers: { 'x-user-sub': 'daniel-sub' },
    accountName: 'negocio',
    store,
    legacyLookup: () => undefined,
  });
  assert.equal(servedToken(resolution), 'SCOPED');
});

// ── criterion 4: isolation with the synthetic sub ────────────────────────

test('pm-test-sin-fila without a row: explicit error, never another sub account', async () => {
  const store = new FakeStore();
  store.seed('someone-else', pairedPayload({ accessToken: 'VICTIM-TOKEN' }));
  const house = houseAccount('skirmshop', 'HOUSE-TOKEN');
  const resolution = await resolveInstagramEntry({
    headers: { 'x-user-sub': 'pm-test-sin-fila' },
    accountName: 'skirmshop',
    store,
    legacyLookup: () => house,
  });
  assert.ok('error' in resolution, 'must error, not serve');
  const error = (resolution as { error: { code: string; message: string } }).error;
  assert.equal(error.code, 'no_instagram_credential');
  assert.match(error.message, /no instagram credential for this user/);
  assert.match(error.message, /pm-test-sin-fila/);
  assert.equal(store.puts.length, 0, 'no adoption of the house token into the caller row');
});

// ── refresh-on-use (criterion 3) ─────────────────────────────────────────

test('near-expiry token is refreshed and written back under the same key', async () => {
  const store = new FakeStore();
  const now = Date.now();
  store.seed('daniel-sub', pairedPayload({ issuedAt: now - 47 * DAY, expiresAt: now + 13 * DAY }));
  const calls: string[] = [];
  const fetchImpl: PairingFetch = async url => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'EAAL-refreshed',
        token_type: 'bearer',
        expires_in: IG_MIN_LONG_LIVED_EXPIRES_IN,
      }),
    };
  };
  const resolution = await resolveInstagramEntry({
    headers: { 'x-user-sub': 'daniel-sub' },
    accountName: 'skirmshop',
    store,
    legacyLookup: () => undefined,
    fetchImpl,
    now,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /refresh_access_token/);
  assert.match(calls[0], /grant_type=ig_refresh_token/);
  assert.equal(servedToken(resolution), 'EAAL-refreshed');
  assert.equal(store.puts.length, 1);
  assert.equal(store.puts[0].key, 'daniel-sub', 'write-back replaces the row it read');
  assert.equal(store.puts[0].payload.accessToken, 'EAAL-refreshed');
  assert.ok((store.puts[0].payload.expiresAt as number) > now + 59 * DAY);
});

test('scoped row keeps its own key on write-back', async () => {
  const store = new FakeStore();
  const now = Date.now();
  store.seed('daniel-sub', pairedPayload({ accessToken: 'PRIMARY' }));
  store.seed(
    'daniel-sub:negocio',
    pairedPayload({ accessToken: 'SCOPED', issuedAt: now - 47 * DAY, expiresAt: now + 3 * DAY })
  );
  await resolveInstagramEntry({
    headers: { 'x-user-sub': 'daniel-sub' },
    accountName: 'negocio',
    store,
    legacyLookup: () => undefined,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'EAAL-scoped-refreshed',
        expires_in: IG_MIN_LONG_LIVED_EXPIRES_IN,
      }),
    }),
    now,
  });
  assert.equal(store.puts.length, 1);
  assert.equal(store.puts[0].key, 'daniel-sub:negocio');
});

test('young token is served untouched (Meta: refresh needs 24h of age)', async () => {
  const store = new FakeStore();
  const now = Date.now();
  store.seed(
    'daniel-sub',
    pairedPayload({ issuedAt: now - 60 * 60 * 1000, expiresAt: now + 1 * DAY })
  );
  let fetchCalls = 0;
  const resolution = await resolveInstagramEntry({
    headers: { 'x-user-sub': 'daniel-sub' },
    accountName: 'skirmshop',
    store,
    legacyLookup: () => undefined,
    fetchImpl: async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => ({}) };
    },
    now,
  });
  assert.equal(fetchCalls, 0);
  assert.equal(servedToken(resolution), 'EAAL-user-token');
});

test('far-from-expiry token is not refreshed', async () => {
  const store = new FakeStore();
  const now = Date.now();
  store.seed('daniel-sub', pairedPayload({ issuedAt: now - 3 * DAY, expiresAt: now + 50 * DAY }));
  let fetchCalls = 0;
  await resolveInstagramEntry({
    headers: { 'x-user-sub': 'daniel-sub' },
    accountName: 'skirmshop',
    store,
    legacyLookup: () => undefined,
    fetchImpl: async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => ({}) };
    },
    now,
  });
  assert.equal(fetchCalls, 0);
});

test('refresh failure keeps serving the current token (loud, not fatal)', async () => {
  const store = new FakeStore();
  const now = Date.now();
  store.seed('daniel-sub', pairedPayload({ issuedAt: now - 47 * DAY, expiresAt: now + 5 * DAY }));
  const logs: string[] = [];
  const resolution = await resolveInstagramEntry({
    headers: { 'x-user-sub': 'daniel-sub' },
    accountName: 'skirmshop',
    store,
    legacyLookup: () => undefined,
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'cannot refresh' } }),
    }),
    now,
    log: msg => logs.push(msg),
  });
  assert.equal(servedToken(resolution), 'EAAL-user-token');
  assert.ok(logs.some(line => /refresh FAILED/.test(line)));
  assert.equal(store.puts.length, 0);
});

// ── store bootstrap ──────────────────────────────────────────────────────

test('store bootstrap is dark with the flag off and strict with it on', () => {
  assert.equal(createInstagramCredentialStore({ CREDENTIAL_STORE_ENABLED: 'false' }), null);
  assert.equal(createInstagramCredentialStore({}), null);
  assert.throws(
    () => createInstagramCredentialStore({ CREDENTIAL_STORE_ENABLED: 'true' }),
    /DATABASE_URL is unset/
  );
});
