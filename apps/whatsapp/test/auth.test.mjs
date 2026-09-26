import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculatePKCECodeChallenge } from 'openid-client';
import { createApp } from '../server.mjs';
import { AppAuth } from '../lib/auth.mjs';

const issuer = 'https://idp.example/realms/apps';
const clientId = 'whatsapp-socialmedia';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const sign = claims => {
  const header = b64({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' });
  const payload = b64(claims);
  const input = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(input).end().sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
};

function cookieValue(header, name) {
  const match = header?.match(new RegExp(`${name}=([^;,]+)`));
  return match?.[1] || '';
}

async function fixture(t, { subject = 'owner-sub', now = () => Date.now(), ttl = '1800' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'whatsapp-oidc-test-'));
  const env = {
    APP_AUTH_MODE: 'oidc', APP_PUBLIC_URL: 'https://wa.example',
    OIDC_ISSUER_URL: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: 'test-secret',
    OIDC_ALLOWED_SUBJECTS: 'owner-sub', OIDC_SESSION_TTL_SECONDS: ttl,
    DATA_DIR: dir, APP_ENABLE_SENDING: 'false',
  };
  const idp = { subject, nonce: null, tamperSignature: false, tokenRequests: [] };
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/realms/apps/.well-known/openid-configuration') return Response.json({ issuer, authorization_endpoint: 'https://idp.example/auth', token_endpoint: 'https://idp.example/token', jwks_uri: 'https://idp.example/jwks' });
    if (parsed.pathname === '/jwks') return Response.json({ keys: [jwk] });
    if (parsed.pathname === '/token') {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      idp.tokenRequests.push(form);
      const nowSeconds = Math.floor(Date.now() / 1000);
      let idToken = sign({ iss: issuer, sub: idp.subject, aud: clientId, exp: nowSeconds + 600, iat: nowSeconds, nonce: idp.nonce, email: 'owner@example.com' });
      if (idp.tamperSignature) {
        const parts = idToken.split('.');
        const signature = Buffer.from(parts[2], 'base64url');
        signature[0] ^= 1;
        parts[2] = signature.toString('base64url');
        idToken = parts.join('.');
      }
      return Response.json({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 600, id_token: idToken });
    }
    throw Error(`Unexpected upstream request: ${url}`);
  };
  const app = await createApp({ env, db: { query: async () => ({ rows: [] }) }, registry: [], fetchImpl, now });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
  return { request, idp, port: app.server.address().port, env, dir, fetchImpl };
}

function absoluteRequest(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function login(fixtureResult, returnTo = '/') {
  const { request, idp } = fixtureResult;
  const root = await request('/');
  assert.equal(root.status, 302);
  assert.match(root.headers.get('location'), /^\/auth\/login\?/);
  const login = await request(root.headers.get('location'));
  assert.equal(login.status, 302);
  const location = new URL(login.headers.get('location'));
  idp.nonce = location.searchParams.get('nonce');
  const transaction = `${'__Host-wa_oidc_tx'}=${cookieValue(login.headers.get('set-cookie'), '__Host-wa_oidc_tx')}`;
  const state = location.searchParams.get('state');
  const callback = await request(`/auth/callback?code=test-code&state=${encodeURIComponent(state)}`, { headers: { cookie: transaction } });
  return { callback, session: cookieValue(callback.headers.get('set-cookie'), '__Host-wa_session'), transaction, state, location, returnTo };
}

test('OIDC protects UI/API, validates signed callback claims, and creates an HttpOnly session', async t => {
  const fixtureResult = await fixture(t);
  const { request } = fixtureResult;
  assert.equal((await request('/health')).status, 200);
  const unauthenticated = await request('/api/accounts');
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: 'Authentication required', code: 'AUTH_REQUIRED', loginUrl: '/auth/login' });
  const basicHeader = `Basic ${Buffer.from('operator:password').toString('base64')}`;
  assert.equal((await request('/api/accounts', { headers: { authorization: basicHeader } })).status, 401);
  assert.equal((await request('/api/media/11111111-1111-1111-1111-111111111111?account=personal&chat=chat')).status, 401);
  const result = await login(fixtureResult);
  assert.equal(result.callback.status, 302);
  assert.equal(result.callback.headers.get('location'), '/');
  assert.match(result.callback.headers.get('set-cookie'), /HttpOnly/);
  const accounts = await request('/api/accounts', { headers: { cookie: `__Host-wa_session=${result.session}` } });
  assert.equal(accounts.status, 200);
  const firstScope = (await accounts.json()).outboxScope;
  assert.match(firstScope, /^[a-f0-9]{64}$/);
  assert.notEqual(firstScope, result.session);
  const nextLogin = await login(fixtureResult);
  const nextAccounts = await request('/api/accounts', { headers: { cookie: `__Host-wa_session=${nextLogin.session}` } });
  assert.equal(nextAccounts.status, 200);
  assert.notEqual((await nextAccounts.json()).outboxScope, firstScope, 'a new login must not restore another session outbox');
});

test('OIDC rejects callback state and nonce mismatches and unauthorized subjects', async t => {
  const wrongState = await fixture(t);
  const loginResponse = await wrongState.request('/auth/login?returnTo=%2F');
  const location = new URL(loginResponse.headers.get('location'));
  const transaction = `__Host-wa_oidc_tx=${cookieValue(loginResponse.headers.get('set-cookie'), '__Host-wa_oidc_tx')}`;
  const invalidState = await wrongState.request(`/auth/callback?code=test-code&state=wrong`, { headers: { cookie: transaction } });
  assert.equal(invalidState.status, 400);

  const wrongNonce = await fixture(t);
  const wrongNonceLogin = await wrongNonce.request('/auth/login');
  const wrongNonceLocation = new URL(wrongNonceLogin.headers.get('location'));
  wrongNonce.idp.nonce = 'different-nonce';
  const wrongNonceResult = await wrongNonce.request(`/auth/callback?code=test-code&state=${wrongNonceLocation.searchParams.get('state')}`, { headers: { cookie: `__Host-wa_oidc_tx=${cookieValue(wrongNonceLogin.headers.get('set-cookie'), '__Host-wa_oidc_tx')}` } });
  assert.equal(wrongNonceResult.status, 400);

  const badSignature = await fixture(t);
  const badSignatureLogin = await badSignature.request('/auth/login');
  const badSignatureLocation = new URL(badSignatureLogin.headers.get('location'));
  badSignature.idp.nonce = badSignatureLocation.searchParams.get('nonce');
  badSignature.idp.tamperSignature = true;
  const badSignatureResult = await badSignature.request(`/auth/callback?code=test-code&state=${badSignatureLocation.searchParams.get('state')}`, { headers: { cookie: `__Host-wa_oidc_tx=${cookieValue(badSignatureLogin.headers.get('set-cookie'), '__Host-wa_oidc_tx')}` } });
  assert.equal(badSignatureResult.status, 400);

  const unauthorized = await fixture(t, { subject: 'other-sub' });
  const unauthorizedLogin = await unauthorized.request('/auth/login');
  const unauthorizedLocation = new URL(unauthorizedLogin.headers.get('location'));
  unauthorized.idp.nonce = unauthorizedLocation.searchParams.get('nonce');
  const unauthorizedResult = await unauthorized.request(`/auth/callback?code=test-code&state=${unauthorizedLocation.searchParams.get('state')}`, { headers: { cookie: `__Host-wa_oidc_tx=${cookieValue(unauthorizedLogin.headers.get('set-cookie'), '__Host-wa_oidc_tx')}` } });
  assert.equal(unauthorizedResult.status, 403);
  assert.equal(unauthorizedResult.headers.get('set-cookie'), null);
  assert.equal(location.searchParams.get('state')?.length > 20, true);
});

test('OIDC sessions expire and logout clears the server session', async t => {
  let clock = Date.now();
  const fixtureResult = await fixture(t, { ttl: '10', now: () => clock });
  const result = await login(fixtureResult);
  assert.equal(await calculatePKCECodeChallenge(fixtureResult.idp.tokenRequests[0].get('code_verifier')), result.location.searchParams.get('code_challenge'));
  const cookie = `__Host-wa_session=${result.session}`;
  assert.equal((await fixtureResult.request('/api/accounts', { headers: { cookie } })).status, 200);
  clock += 11_000;
  const expired = await fixtureResult.request('/api/accounts', { headers: { cookie } });
  assert.equal(expired.status, 401);
  const approval = { account: 'personal', chat: 'personal-chat', id: '11111111-1111-1111-1111-111111111111', action: 'approve' };
  const expiredApproval = await fixtureResult.request('/api/ai/proposal', { method: 'POST', headers: { cookie, origin: 'https://wa.example', 'content-type': 'application/json' }, body: JSON.stringify(approval) });
  assert.equal(expiredApproval.status, 401);
  const fresh = await fixture(t);
  const loggedIn = await login(fresh);
  const getLogout = await fresh.request('/auth/logout', { method: 'GET', headers: { cookie: `__Host-wa_session=${loggedIn.session}`, origin: 'https://evil.example' } });
  assert.equal(getLogout.status, 405);
  assert.equal((await fresh.request('/api/accounts', { headers: { cookie: `__Host-wa_session=${loggedIn.session}` } })).status, 200);
  const wrongOriginPost = await fresh.request('/auth/logout', { method: 'POST', headers: { cookie: `__Host-wa_session=${loggedIn.session}`, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(wrongOriginPost.status, 403);
  assert.equal((await fresh.request('/api/accounts', { headers: { cookie: `__Host-wa_session=${loggedIn.session}` } })).status, 200);
  const logout = await fresh.request('/auth/logout', { method: 'POST', headers: { cookie: `__Host-wa_session=${loggedIn.session}`, origin: 'https://wa.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(logout.status, 204);
  assert.equal((await fresh.request('/api/accounts', { headers: { cookie: `__Host-wa_session=${loggedIn.session}` } })).status, 401);
  const loggedOutApproval = await fresh.request('/api/ai/proposal', { method: 'POST', headers: { cookie: `__Host-wa_session=${loggedIn.session}`, origin: 'https://wa.example', 'content-type': 'application/json' }, body: JSON.stringify(approval) });
  assert.equal(loggedOutApproval.status, 401);
});

test('30-day OIDC session survives app restart and logout remains durable', async t => {
  const original = await fixture(t, { ttl: '2592000' });
  const loginResult = await login(original);
  assert.match(loginResult.callback.headers.get('set-cookie'), /Max-Age=2592000/);
  assert.equal((await stat(join(original.dir, 'auth'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(original.dir, 'auth', 'oidc-sessions.json'))).mode & 0o777, 0o600);
  const req = { headers: { cookie: `__Host-wa_session=${loginResult.session}` } };
  const reloaded = new AppAuth({ env: original.env, fetchImpl: original.fetchImpl });
  await reloaded.init(original.dir);
  assert.equal(reloaded.isAuthenticated(req)?.subject, 'owner-sub');
  await reloaded.logout(req);
  const afterLogout = new AppAuth({ env: original.env, fetchImpl: original.fetchImpl });
  await afterLogout.init(original.dir);
  assert.equal(afterLogout.isAuthenticated(req), null);
});

test('OIDC callback ignores hostile absolute request authorities', async t => {
  const fixtureResult = await fixture(t);
  const loginResponse = await fixtureResult.request('/auth/login');
  const location = new URL(loginResponse.headers.get('location'));
  fixtureResult.idp.nonce = location.searchParams.get('nonce');
  const transaction = `__Host-wa_oidc_tx=${cookieValue(loginResponse.headers.get('set-cookie'), '__Host-wa_oidc_tx')}`;
  const response = await absoluteRequest(fixtureResult.port, `https://attacker.example/auth/callback?code=test-code&state=${encodeURIComponent(location.searchParams.get('state'))}`, { cookie: transaction });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/');
  assert.equal(fixtureResult.idp.tokenRequests[0].get('redirect_uri'), 'https://wa.example/auth/callback');
});
