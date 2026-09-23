/**
 * SC-1194 P1 (SC-1143): Instagram Login pairing plumbing, Meta mocked.
 * Covers epic criteria 2 and 3 at code+test level: authorize URL shape, state
 * signing, the 60-day floor on the long-lived exchange, refresh, and the
 * store.put under the sub's session_key (envelope crypto itself is specced
 * under the mcp-server jest harness for shared/).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type {
  CredentialChannel,
  CredentialStore,
  StoredCredential,
} from '@mcp-socialmedia/shared';
import {
  IG_AUTHORIZE_URL,
  IG_MIN_LONG_LIVED_EXPIRES_IN,
  PairingFetch,
  PairingResponse,
  buildAuthorizeUrl,
  deriveStateSecret,
  exchangeAuthorizationCode,
  exchangeForLongLivedToken,
  fetchInstagramIdentity,
  instagramLoginConfigFromEnv,
  pairInstagramAccount,
  refreshInstagramToken,
  sessionKeyForPairing,
  signPairingState,
  verifyPairingState,
} from './oauth-pairing';

const STATE_SECRET = deriveStateSecret(Buffer.alloc(32, 7));
const CONFIG = {
  clientId: '1869504556900523',
  clientSecret: 'test-app-secret',
  redirectUri: 'https://whatsapp.e-dani.com/oauth/instagram/callback',
  stateSecret: STATE_SECRET,
};

class FakeStore implements CredentialStore {
  rows = new Map<string, StoredCredential>();
  puts: { key: string; channel: CredentialChannel; payload: Record<string, unknown> }[] = [];

  async get(sessionKey: string, channel: CredentialChannel): Promise<StoredCredential | null> {
    return this.rows.get(`${sessionKey}/${channel}`) ?? null;
  }
  async put(
    sessionKey: string,
    channel: CredentialChannel,
    payload: Record<string, unknown>
  ): Promise<void> {
    this.puts.push({ key: sessionKey, channel, payload });
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

function metaFetch(handlers: Record<string, () => unknown>): { fetch: PairingFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: PairingFetch = async (url: string) => {
    calls.push(url);
    for (const [needle, handler] of Object.entries(handlers)) {
      if (url.includes(needle)) {
        const body = handler();
        const response: PairingResponse = { ok: true, status: 200, json: async () => body };
        return response;
      }
    }
    return { ok: false, status: 400, json: async () => ({ error: { message: `unhandled ${url}` } }) };
  };
  return { fetch: fetchImpl, calls };
}

// ── state ────────────────────────────────────────────────────────────────

test('state round-trips through sign/verify', () => {
  const now = 1_700_000_000_000;
  const state = signPairingState({ sub: 'e51253a7-c137-4c6c-9fb9-af9cecd3b147', exp: 0 }, STATE_SECRET, now);
  const decoded = verifyPairingState(state, STATE_SECRET, now + 1000);
  assert.ok(decoded);
  assert.equal(decoded.sub, 'e51253a7-c137-4c6c-9fb9-af9cecd3b147');
  assert.equal(decoded.label, undefined);
});

test('state carries an account label for second accounts', () => {
  const now = 1_700_000_000_000;
  const state = signPairingState(
    { sub: 'sub-a', label: 'negocio', exp: 0 },
    STATE_SECRET,
    now
  );
  const decoded = verifyPairingState(state, STATE_SECRET, now + 1);
  assert.equal(decoded?.label, 'negocio');
});

test('tampered state is rejected', () => {
  const now = 1_700_000_000_000;
  const state = signPairingState({ sub: 'sub-a', exp: 0 }, STATE_SECRET, now);
  const [v, payload, mac] = state.split('.');
  const evilPayload = Buffer.from(JSON.stringify({ sub: 'victim', exp: now + 60000 })).toString(
    'base64url'
  );
  assert.equal(verifyPairingState(`${v}.${evilPayload}.${mac}`, STATE_SECRET, now), null);
  // and a state signed with another key is rejected
  const otherSecret = createHmac('sha256', Buffer.alloc(32, 9)).digest();
  assert.equal(verifyPairingState(state, otherSecret, now), null);
});

test('expired state is rejected, garbage never verifies', () => {
  const now = 1_700_000_000_000;
  const state = signPairingState({ sub: 'sub-a', exp: 0 }, STATE_SECRET, now, 1000);
  assert.equal(verifyPairingState(state, STATE_SECRET, now + 2000), null);
  assert.equal(verifyPairingState('nonsense', STATE_SECRET, now), null);
  assert.equal(verifyPairingState('', STATE_SECRET, now), null);
});

// ── authorize URL (criterion 2, step 1) ──────────────────────────────────

test('authorize URL pins the documented parameters and scopes', () => {
  const url = new URL(buildAuthorizeUrl(CONFIG, 'v1.abc.def'));
  assert.equal(`${url.protocol}//${url.host}${url.pathname}`, IG_AUTHORIZE_URL);
  assert.equal(url.searchParams.get('client_id'), '1869504556900523');
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.redirectUri);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(
    url.searchParams.get('scope'),
    'instagram_business_basic,instagram_business_content_publish'
  );
  assert.equal(url.searchParams.get('state'), 'v1.abc.def');
});

// ── config from env ──────────────────────────────────────────────────────

test('pairing config is dark while the credential-store flag is off', () => {
  assert.equal(
    instagramLoginConfigFromEnv({
      FACEBOOK_APP_ID: '1',
      FACEBOOK_APP_SECRET: 's',
      INSTAGRAM_OAUTH_REDIRECT_URI: 'https://x/cb',
      CREDENTIAL_STORE_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    }),
    null
  );
  assert.equal(
    instagramLoginConfigFromEnv({
      CREDENTIAL_STORE_ENABLED: 'true',
      INSTAGRAM_OAUTH_REDIRECT_URI: 'https://x/cb',
      CREDENTIAL_STORE_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    }),
    null,
    'missing app credentials → no config'
  );
  const cfg = instagramLoginConfigFromEnv({
    CREDENTIAL_STORE_ENABLED: 'true',
    FACEBOOK_APP_ID: 'fb-id',
    FACEBOOK_APP_SECRET: 'fb-secret',
    INSTAGRAM_OAUTH_REDIRECT_URI: 'https://x/cb',
    CREDENTIAL_STORE_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
  });
  assert.ok(cfg);
  assert.equal(cfg.clientId, 'fb-id', 'falls back to the FB app pair');
  const ig = instagramLoginConfigFromEnv({
    CREDENTIAL_STORE_ENABLED: 'true',
    FACEBOOK_APP_ID: 'fb-id',
    FACEBOOK_APP_SECRET: 'fb-secret',
    INSTAGRAM_LOGIN_APP_ID: 'ig-id',
    INSTAGRAM_LOGIN_APP_SECRET: 'ig-secret',
    INSTAGRAM_OAUTH_REDIRECT_URI: 'https://x/cb',
    CREDENTIAL_STORE_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
  });
  assert.equal(ig?.clientId, 'ig-id', 'Instagram Login pair wins when provisioned');
});

// ── exchanges (criteria 2 and 3) ─────────────────────────────────────────

test('code exchange posts the authorization_code grant server-side', async () => {
  const seen: { url: string; init?: Record<string, unknown> }[] = [];
  const fetchImpl: PairingFetch = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ access_token: 'SHORT', user_id: 178 }) };
  };
  const out = await exchangeAuthorizationCode('CODE123', CONFIG, fetchImpl);
  assert.equal(out.accessToken, 'SHORT');
  assert.equal(out.userId, '178');
  assert.match(seen[0].url, /oauth\/access_token$/);
  const body = String(seen[0].init?.body);
  assert.match(body, /grant_type=authorization_code/);
  assert.match(body, /code=CODE123/);
  assert.match(body, /client_secret=test-app-secret/);
});

test('long-lived exchange enforces the 60-day floor', async () => {
  const { fetch } = metaFetch({
    '/access_token': () => ({
      access_token: 'EAAL-long',
      token_type: 'bearer',
      expires_in: IG_MIN_LONG_LIVED_EXPIRES_IN,
    }),
  });
  const out = await exchangeForLongLivedToken('SHORT', CONFIG, fetch);
  assert.equal(out.accessToken, 'EAAL-long');
  assert.ok(out.expiresAt > Date.now() + 50 * 24 * 3600 * 1000, '≈60 days ahead');

  const shorty = metaFetch({
    '/access_token': () => ({ access_token: 'EAAL', token_type: 'bearer', expires_in: 3600 }),
  });
  await assert.rejects(
    exchangeForLongLivedToken('SHORT', CONFIG, shorty.fetch),
    /refusing tokens under 5184000/
  );
});

test('long-lived exchange sends ig_exchange_token and the client secret', async () => {
  const { fetch, calls } = metaFetch({
    '/access_token': () => ({
      access_token: 'EAAL',
      token_type: 'bearer',
      expires_in: IG_MIN_LONG_LIVED_EXPIRES_IN,
    }),
  });
  await exchangeForLongLivedToken('SHORT', CONFIG, fetch);
  const url = new URL(calls[0]);
  assert.equal(url.host, 'graph.instagram.com');
  assert.equal(url.searchParams.get('grant_type'), 'ig_exchange_token');
  assert.equal(url.searchParams.get('client_secret'), 'test-app-secret');
  assert.equal(url.searchParams.get('access_token'), 'SHORT');
});

test('identity lookup reads id, user_id and username from /me', async () => {
  const { fetch } = metaFetch({
    '/me': () => ({ id: '17841444094675941', user_id: '17841444094675941', username: 'skirmshopes' }),
  });
  const identity = await fetchInstagramIdentity('EAAL', fetch);
  assert.equal(identity.id, '17841444094675941');
  assert.equal(identity.username, 'skirmshopes');
});

test('refresh hits refresh_access_token with ig_refresh_token and keeps the floor', async () => {
  const { fetch, calls } = metaFetch({
    '/refresh_access_token': () => ({
      access_token: 'EAAL-next',
      token_type: 'bearer',
      expires_in: IG_MIN_LONG_LIVED_EXPIRES_IN,
    }),
  });
  const out = await refreshInstagramToken('EAAL-current', fetch);
  assert.equal(out.accessToken, 'EAAL-next');
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('grant_type'), 'ig_refresh_token');
  assert.equal(url.searchParams.get('access_token'), 'EAAL-current');

  const bad = metaFetch({
    '/refresh_access_token': () => ({ access_token: 'X', expires_in: 60 }),
  });
  await assert.rejects(refreshInstagramToken('EAAL', bad.fetch), /refusing tokens under 5184000/);
});

// ── session key convention ───────────────────────────────────────────────

test('session key: first account under sub, second under sub:username', () => {
  assert.equal(sessionKeyForPairing('sub-a', undefined, null, { id: '111', username: 'uno' }), 'sub-a');
  const existing: StoredCredential = {
    sessionKey: 'sub-a',
    channel: 'instagram',
    payload: { accessToken: 't', businessAccountId: '111' },
    updatedAt: new Date(),
  };
  assert.equal(
    sessionKeyForPairing('sub-a', undefined, existing, { id: '111', username: 'uno' }),
    'sub-a',
    're-pairing the same account rotates in place'
  );
  assert.equal(
    sessionKeyForPairing('sub-a', undefined, existing, { id: '222', username: 'dos' }),
    'sub-a:dos'
  );
  assert.equal(sessionKeyForPairing('sub-a', 'negocio', existing, { id: '222', username: 'dos' }), 'sub-a:negocio');
  const longUsername = 'u'.repeat(40);
  const key = sessionKeyForPairing(
    '12345678-1234-1234-1234-123456789abc',
    undefined,
    existing,
    { id: '17841444094675941', username: longUsername }
  );
  assert.ok(
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(key),
    'overflowing username falls back to the account id'
  );
});

// ── full pairing orchestration ───────────────────────────────────────────

test('pairing stores the 60-day credential under the sub (criterion 2)', async () => {
  const store = new FakeStore();
  const { fetch, calls } = metaFetch({
    'api.instagram.com/oauth/access_token': () => ({ access_token: 'SHORT', user_id: '178' }),
    'grant_type=ig_exchange_token': () => ({
      access_token: 'EAAL-long',
      token_type: 'bearer',
      expires_in: IG_MIN_LONG_LIVED_EXPIRES_IN,
    }),
    '/me?': () => ({ id: '17841444094675941', user_id: '17841444094675941', username: 'skirmshopes' }),
  });
  const now = Date.now();
  const state = signPairingState({ sub: 'daniel-sub', exp: 0 }, STATE_SECRET, now);
  const result = await pairInstagramAccount({ code: 'CODE', state, config: CONFIG, store, fetchImpl: fetch, now });

  assert.equal(result.sessionKey, 'daniel-sub');
  assert.equal(result.username, 'skirmshopes');
  assert.equal(calls.length, 3);
  assert.equal(store.puts.length, 1);
  const [put] = store.puts;
  assert.equal(put.key, 'daniel-sub');
  assert.equal(put.channel, 'instagram');
  assert.equal(put.payload.accessToken, 'EAAL-long');
  assert.equal(put.payload.businessAccountId, '17841444094675941');
  assert.equal(put.payload.username, 'skirmshopes');
  assert.ok(
    (put.payload.expiresAt as number) >= now + (IG_MIN_LONG_LIVED_EXPIRES_IN - 5) * 1000,
    'expiry recorded ~60 days out'
  );
  assert.equal(put.payload.issuedAt, now);
});

test('pairing rejects an expired state before touching Meta', async () => {
  const store = new FakeStore();
  let called = 0;
  const fetchImpl: PairingFetch = async () => {
    called++;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const now = Date.now();
  const state = signPairingState({ sub: 's', exp: 0 }, STATE_SECRET, now, 1000);
  await assert.rejects(
    pairInstagramAccount({ code: 'C', state, config: CONFIG, store, fetchImpl, now: now + 5000 }),
    /invalid or expired instagram pairing state/
  );
  assert.equal(called, 0);
  assert.equal(store.puts.length, 0);
});

test('pairing of a second account lands under sub:username', async () => {
  const store = new FakeStore();
  await store.put('daniel-sub', 'instagram', { accessToken: 'OLD', businessAccountId: '111' });
  const { fetch } = metaFetch({
    'api.instagram.com/oauth/access_token': () => ({ access_token: 'SHORT' }),
    'grant_type=ig_exchange_token': () => ({
      access_token: 'EAAL-two',
      expires_in: IG_MIN_LONG_LIVED_EXPIRES_IN,
    }),
    '/me?': () => ({ id: '222', username: 'barbelpapis' }),
  });
  const now = Date.now();
  const state = signPairingState({ sub: 'daniel-sub', exp: 0 }, STATE_SECRET, now);
  const result = await pairInstagramAccount({ code: 'C', state, config: CONFIG, store, fetchImpl: fetch, now });
  assert.equal(result.sessionKey, 'daniel-sub:barbelpapis');
  assert.equal(store.puts[store.puts.length - 1].payload.accessToken, 'EAAL-two');
});
