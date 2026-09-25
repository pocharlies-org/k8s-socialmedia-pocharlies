/**
 * SC-1227 (SC-1197 P1b) — acceptance-level specs for social-api:
 * JWT verification against a LOCAL JWKS (RSA keypair generated in this file,
 * served over 127.0.0.1), pairing routes proxying a FAKE whatsapp-pairing
 * pool that checks the connector HMAC and counts calls, and the hardening
 * gates (Origin, cross-sub, flag off, store off, pool errors).
 *
 * Covers the story criteria: no token → 401 with zero pool calls and zero
 * rows; expired / foreign iss / aud without social-api / azp outside the
 * list → 401; valid token → 200 with qr + caducidad; foreign Origin → 403;
 * foreign sub in body or query → 403; unreachable JWKS → 503; /me/whatsapp
 * of A never returns B's jid; flag off → 404 except /health.
 *
 * SC-1228 (P2) extends this harness for GET /social/status: an in-memory
 * fake credential store (reads counted, writes impossible), the fake pool
 * answering expired/qr states for reserved sessionKeys, and a temp identity-
 * bindings file — A/B isolation, the four channel states, store-off → 200
 * with everything `unavailable`, and the same 401/403/404 gates.
 *
 * SC-1229 (P4b) extends the fake pool to the telegram base
 * (/internal/telegram/sessions, same HMAC, plus the /password route) and
 * covers the telegram routes: the QR step, A/B isolation of /me/telegram,
 * the 2FA passthrough (200 / 409) and its own 400 validation, and the
 * architect point — the two pools are INDEPENDENT: telegramPairing null
 * 503s only the telegram routes (and only makes telegram `unavailable` in
 * /social/status), whatsappPairing null only the whatsapp ones.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

type SignKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
import { CredentialChannel, CredentialStore, StoredCredential } from '@mcp-socialmedia/shared';
import { SocialApiContext } from '../api/context';
import { jwtVerifierConfigFromEnv } from '../api/auth/keycloak-jwt';
import { PairingPoolClient } from '../api/pairing-pool-client';
import { createSocialApiApp } from './app';

const ISS = 'https://auth-next.e-dani.com/realms/edani';
const SECRET = 'test-connector-secret';
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const C = 'cccccccc-3333-4333-8333-cccccccccccc';
const KID = 'test-key-1';

const PAIRED: Record<
  string,
  { id: string; jid: string; phone: string | null; name: string | null }
> = {
  [A]: {
    id: '3460000000001:12@s.whatsapp.net',
    jid: '3460000000001@s.whatsapp.net',
    phone: '+3460000000001',
    name: 'Ana',
  },
  [B]: {
    id: '3460000000002:14@s.whatsapp.net',
    jid: '3460000000002@s.whatsapp.net',
    phone: '+3460000000002',
    name: 'Bea',
  },
};

/** Telegram identities the fake telegram pool knows (SC-1229). */
const TG: Record<string, { id: string; username: string | null }> = {
  [A]: { id: '123456789', username: 'ana_tg' },
  [B]: { id: '987654321', username: 'bea_tg' },
  pwsub: { id: '555666777', username: 'pw_user' },
};

let privateKey: SignKey;
let otherPrivateKey: SignKey;
let jwksPort = 0;
let poolPort = 0;
let appServer: Server | null = null;
let appBase = '';

const poolCalls: Array<{
  channel: 'whatsapp' | 'telegram';
  route: string;
  sessionKey: string;
  signatureOk: boolean;
}> = [];
/** What the fake pool would persist as credential rows: only paired subs. */
const storeRows = new Set<string>(Object.keys(PAIRED));

/**
 * SC-1228: the in-memory credential store social-api reads for /social/status
 * (Instagram only — the whatsapp state comes from the pool). Reads are
 * counted for the "sin JWT → cero lecturas" assertion; writes THROW: this
 * process must never touch a row (the pool is the only writer).
 */
class FakeCredentialStore implements CredentialStore {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly reads: Array<{ sessionKey: string; channel: CredentialChannel }> = [];
  key(sessionKey: string, channel: CredentialChannel): string {
    return `${sessionKey}:${channel}`;
  }
  async get(sessionKey: string, channel: CredentialChannel): Promise<StoredCredential | null> {
    this.reads.push({ sessionKey, channel });
    const payload = this.rows.get(this.key(sessionKey, channel));
    if (!payload) return null;
    return { sessionKey, channel, payload, updatedAt: new Date() };
  }
  async put(): Promise<void> {
    throw new Error('social-api must never write a credential row');
  }
  async delete(): Promise<void> {
    throw new Error('social-api must never delete a credential row');
  }
}
const fakeStore = new FakeCredentialStore();

/** Instagram rows keyed by sub (payload shaped by the instagram adapter). */
const IG = {
  [A]: {
    accessToken: 'ig-token-a',
    businessAccountId: '17841',
    username: 'ana_ig',
    expiresAt: Date.now() + 86_400_000,
  },
  [B]: {
    accessToken: 'ig-token-b',
    businessAccountId: '17842',
    username: 'bea_ig',
    expiresAt: Date.now() + 86_400_000,
  },
};
fakeStore.rows.set(`${A}:instagram`, IG[A]);
fakeStore.rows.set(`${B}:instagram`, IG[B]);
// expired token, legacy row without expiresAt, and a foreign-shaped row:
fakeStore.rows.set('igexpired:instagram', {
  accessToken: 'x',
  businessAccountId: '1',
  username: 'zoe_ig',
  expiresAt: Date.now() - 1000,
});
fakeStore.rows.set('iglegacy:instagram', { accessToken: 'x', businessAccountId: '1' });
fakeStore.rows.set('igbroken:instagram', { notAToken: true });

/** Identity bindings table for houseAccounts (format of the mounted ConfigMap). */
const bindingsDir = mkdtempSync(join(tmpdir(), 'social-status-bindings-'));
const bindingsFile = join(bindingsDir, 'social-identity-bindings.yaml');
writeFileSync(
  bindingsFile,
  [
    'bindings:',
    `  - sub: ${A}`,
    '    label: Ana',
    '    accounts: [professional, skirmshop]',
    `  - sub: ${B}`,
    '    label: Bea',
    '    accounts: [personal]',
    '',
  ].join('\n')
);

function qrPayload(): Record<string, unknown> {
  const now = Date.now();
  return {
    value: '2@uQKTESTDATA,1ABCDEF==',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 59_000).toISOString(),
  };
}

async function startJwksServer(
  publicKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey']
): Promise<Server> {
  const jwk = await exportJWK(publicKey);
  const jwks = JSON.stringify({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] });
  const server = createServer((req, res) => {
    if (req.url === '/certs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(jwks);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/**
 * The fake pools: the internal sessions APIs of P1a (whatsapp) and P4b
 * (telegram) as one plain node server, one base per channel. Verifies the
 * connector HMAC exactly like createHMACAuth (sha256=HMAC over
 * "<ts>:<JSON body>", 5-minute window), records every call with its channel,
 * and answers the PairingStatus / TelegramPairingStatus contracts — the
 * telegram side adding the `password` state and the /password route.
 */
async function startFakePool(): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: Record<string, unknown>, headers = {}): void => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      const match = /^\/internal\/(whatsapp|telegram)\/sessions\/(start|state|me|password)$/.exec(
        req.url || ''
      );
      if (!match || req.method !== 'POST') return send(404, { error: 'not_found' });
      const channel = match[1] as 'whatsapp' | 'telegram';
      const route = match[2];
      // /password is a telegram-only route (the whatsapp pool 404s it).
      if (channel === 'whatsapp' && route === 'password') return send(404, { error: 'not_found' });
      const raw = Buffer.concat(chunks).toString('utf-8');
      let body: { sessionKey?: unknown };
      try {
        body = JSON.parse(raw) as { sessionKey?: unknown };
      } catch {
        return send(400, { error: 'invalid_json' });
      }
      const ts = req.headers['x-connector-timestamp'] as string;
      const sig = req.headers['x-connector-signature'] as string;
      const expected = `sha256=${createHmac('sha256', SECRET)
        .update(`${ts}:${JSON.stringify(body)}`)
        .digest('hex')}`;
      const signatureOk = !!ts && !!sig && sig === expected;
      const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey : '';
      poolCalls.push({ channel, route, sessionKey, signatureOk });
      if (!signatureOk) return send(401, { error: 'Invalid signature' });
      if (sessionKey === 'pool503') return send(503, { error: 'pairing_unavailable' });
      if (sessionKey === 'pool429') {
        return send(
          429,
          { error: 'rate_limited', reason: 'start_interval', retryAfterSeconds: 61 },
          {
            'Retry-After': '61',
          }
        );
      }
      if (channel === 'telegram') {
        if (route === 'password') {
          // the 2FA step: only `pwsub` sits waiting for a password; the
          // submit completes its pairing.
          if (sessionKey === 'pwsub')
            return send(200, { sessionKey, state: 'paired', qr: null, me: TG.pwsub });
          return send(409, { error: 'password_not_requested' });
        }
        if (route === 'me') {
          const me = TG[sessionKey];
          if (!me) return send(404, { error: 'not_paired' });
          return send(200, { sessionKey, me });
        }
        if (route === 'state') {
          if (sessionKey === 'expiredtg')
            return send(200, { sessionKey, state: 'expired', qr: null, me: null });
          if (sessionKey === 'qrtg')
            return send(200, { sessionKey, state: 'qr', qr: qrPayload(), me: null });
          if (sessionKey === 'passwordtg')
            return send(200, { sessionKey, state: 'password', qr: null, me: null });
          const me = TG[sessionKey];
          if (me) return send(200, { sessionKey, state: 'paired', qr: null, me });
          return send(200, { sessionKey, state: 'unpaired', qr: null, me: null });
        }
        if (TG[sessionKey])
          return send(200, { sessionKey, state: 'paired', qr: null, me: TG[sessionKey] });
        return send(200, { sessionKey, state: 'qr', qr: qrPayload(), me: null });
      }
      if (route === 'me') {
        const me = PAIRED[sessionKey];
        if (!me) return send(404, { error: 'not_paired' });
        return send(200, { sessionKey, me });
      }
      if (route === 'state') {
        // SC-1228 reserved sessionKeys: the states the fake pool cannot
        // reach through PAIRED alone (provider-invalidated, pairing in flight).
        if (sessionKey === 'expiredwa')
          return send(200, { sessionKey, state: 'expired', qr: null, me: null });
        if (sessionKey === 'qrsub')
          return send(200, { sessionKey, state: 'qr', qr: qrPayload(), me: null });
        const me = PAIRED[sessionKey];
        if (me) return send(200, { sessionKey, state: 'paired', qr: null, me });
        return send(200, { sessionKey, state: 'unpaired', qr: null, me: null });
      }
      // start: a fresh QR for anyone not paired; paired subs keep their state
      if (PAIRED[sessionKey]) {
        const me = PAIRED[sessionKey];
        return send(200, { sessionKey, state: 'paired', qr: null, me });
      }
      return send(200, { sessionKey, state: 'qr', qr: qrPayload(), me: null });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

let jwksServer: Server;
let poolServer: Server;

beforeAll(async () => {
  // ONE extractable keypair: its public half is the local JWKS, its private
  // half signs the tokens. The second keypair is absent from the JWKS.
  const home = await generateKeyPair('RS256', { extractable: true });
  privateKey = home.privateKey;
  otherPrivateKey = (await generateKeyPair('RS256', { extractable: false })).privateKey;
  jwksServer = await startJwksServer(home.publicKey);
  jwksPort = (jwksServer.address() as AddressInfo).port;
  poolServer = await startFakePool();
  poolPort = (poolServer.address() as AddressInfo).port;
});

afterAll(async () => {
  if (appServer) await new Promise<void>(resolve => appServer?.close(() => resolve()));
  await new Promise<void>(resolve => jwksServer.close(() => resolve()));
  await new Promise<void>(resolve => poolServer.close(() => resolve()));
});

afterEach(() => {
  poolCalls.length = 0;
  fakeStore.reads.length = 0;
});

async function serve(overrides: Partial<SocialApiContext> = {}): Promise<void> {
  if (appServer) {
    await new Promise<void>(resolve => appServer?.close(() => resolve()));
    appServer = null;
  }
  const ctx: SocialApiContext = {
    apiEnabled: true,
    storeAvailable: true,
    allowedOrigins: [],
    jwt: {
      issuer: ISS,
      jwksUrl: `http://127.0.0.1:${jwksPort}/certs`,
      audience: 'social-api',
      allowedAzp: ['dgx-messages'],
      clockToleranceSeconds: 30,
    },
    whatsappPairing: new PairingPoolClient(
      'whatsapp',
      `http://127.0.0.1:${poolPort}`,
      SECRET,
      5000
    ),
    telegramPairing: new PairingPoolClient(
      'telegram',
      `http://127.0.0.1:${poolPort}`,
      SECRET,
      5000
    ),
    credentialStore: fakeStore,
    identityBindingsPath: bindingsFile,
    logError: () => {},
    ...overrides,
  };
  const app = createSocialApiApp(ctx);
  appServer = await new Promise<Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
}

interface TokenOverrides {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  azp?: string | null;
  typ?: string | null;
  expiresInSec?: number;
  key?: 'good' | 'other';
}

async function token(overrides: TokenOverrides = {}): Promise<string> {
  const key = overrides.key === 'other' ? otherPrivateKey : privateKey;
  // jose v6: custom claims (azp) go through the constructor's claims set.
  const claims: Record<string, unknown> = {};
  if (overrides.azp !== null) claims.azp = overrides.azp ?? 'dgx-messages';
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: 'RS256',
      kid: overrides.key === 'other' ? 'other-key' : KID,
      // typ 'JWT': what the live edani realm (Keycloak 26.6.2) puts in its
      // access tokens — measured 2026-09-25. The verifier does not check typ.
      ...(overrides.typ === null ? {} : { typ: overrides.typ ?? 'JWT' }),
    })
    .setIssuer(overrides.iss ?? ISS)
    .setAudience(overrides.aud ?? 'social-api')
    .setSubject(overrides.sub ?? A)
    .setExpirationTime(`${overrides.expiresInSec ?? 60}s`)
    .sign(key);
}

async function call(
  method: string,
  path: string,
  init: { bearer?: string | null; origin?: string; body?: unknown } = {}
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  if (init.origin) headers.Origin = init.origin;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${appBase}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* no body */
  }
  return { status: res.status, json, headers: res.headers };
}

/** Nested access for the /social/status assertions (json.channels is unknown). */
function chan(r: { json: Record<string, unknown> }): Record<string, { state: string }> {
  return r.json.channels as Record<string, { state: string }>;
}

describe('social-api JWT verifier (local JWKS)', () => {
  beforeAll(async () => {
    await serve();
  });

  it('without a token: 401 + WWW-Authenticate: Bearer and the pool is NOT called', async () => {
    const r = await call('POST', '/pairing/whatsapp/start');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer');
    expect(poolCalls).toHaveLength(0);

    const m = await call('GET', '/me/whatsapp');
    expect(m.status).toBe(401);
    expect(poolCalls).toHaveLength(0);
  });

  it('expired token → 401', async () => {
    const r = await call('POST', '/pairing/whatsapp/start', {
      bearer: await token({ expiresInSec: -120 }),
    });
    expect(r.status).toBe(401);
    expect(poolCalls).toHaveLength(0);
  });

  it('foreign iss → 401', async () => {
    const r = await call('POST', '/pairing/whatsapp/start', {
      bearer: await token({ iss: 'https://evil.example/realms/other' }),
    });
    expect(r.status).toBe(401);
  });

  it('aud without social-api → 401; aud CONTAINING social-api → ok', async () => {
    const bad = await call('POST', '/pairing/whatsapp/start', {
      bearer: await token({ aud: 'somebody-else' }),
    });
    expect(bad.status).toBe(401);
    const arrayed = await call('GET', '/pairing/whatsapp', {
      bearer: await token({ aud: ['social-api', 'other'] }),
    });
    expect(arrayed.status).toBe(200);
  });

  it('azp outside the allowlist (or missing) → 401', async () => {
    const wrong = await call('GET', '/me/whatsapp', {
      bearer: await token({ azp: 'someone-else' }),
    });
    expect(wrong.status).toBe(401);
    const missing = await call('GET', '/me/whatsapp', { bearer: await token({ azp: null }) });
    expect(missing.status).toBe(401);
  });

  // The JOSE `typ` header is NOT part of the identity contract: the live
  // edani realm signs its access tokens with typ 'JWT' (Keycloak 26.6.2,
  // measured 2026-09-25), so imposing 'Bearer' would reject every real token.
  // Identity is fixed by RS256 against the realm JWKS + iss + aud + azp + exp.
  it('typ header is not imposed: the realm value JWT is accepted, as is Bearer', async () => {
    const realm = await call('GET', '/me/whatsapp', { bearer: await token({ typ: 'JWT' }) });
    expect(realm.status).toBe(200);
    const legacy = await call('GET', '/me/whatsapp', { bearer: await token({ typ: 'Bearer' }) });
    expect(legacy.status).toBe(200);
    const absent = await call('GET', '/me/whatsapp', { bearer: await token({ typ: null }) });
    expect(absent.status).toBe(200);
  });

  it('token signed by a key absent from the JWKS → 401', async () => {
    const r = await call('GET', '/me/whatsapp', { bearer: await token({ key: 'other' }) });
    expect(r.status).toBe(401);
  });

  it('x-user-sub is never an input: forged header with no token → 401', async () => {
    const res = await fetch(`${appBase}/me/whatsapp`, {
      headers: { 'x-user-sub': A },
    });
    expect(res.status).toBe(401);
    expect(poolCalls).toHaveLength(0);
  });

  it('unreachable JWKS → 503', async () => {
    await serve({
      jwt: {
        issuer: ISS,
        jwksUrl: 'http://127.0.0.1:9/certs', // closed port: fetch fails
        audience: 'social-api',
        allowedAzp: ['dgx-messages'],
        clockToleranceSeconds: 30,
      },
    });
    const r = await call('GET', '/me/whatsapp', { bearer: await token() });
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: 'identity_unavailable' });
    expect(poolCalls).toHaveLength(0);
    await serve();
  });
});

describe('social-api pairing routes', () => {
  beforeAll(async () => {
    await serve();
  });

  it('valid token: start answers 200 with qr + caducidad, signed HMAC to the pool', async () => {
    const bearer = await token({ sub: C });
    const r = await call('POST', '/pairing/whatsapp/start', { bearer });
    expect(r.status).toBe(200);
    expect(r.json.state).toBe('qr');
    const qr = r.json.qr as Record<string, unknown>;
    expect(typeof qr.value).toBe('string');
    expect(typeof qr.dataUrl).toBe('string');
    expect(typeof qr.expiresAt).toBe('string');
    expect(new Date(String(qr.expiresAt)).getTime()).toBeGreaterThan(Date.now());
    // the pool saw exactly one call: sessionKey = sub, body signed correctly
    expect(poolCalls).toEqual([
      { channel: 'whatsapp', route: 'start', sessionKey: C, signatureOk: true },
    ]);
  });

  it('GET /pairing/whatsapp polls state + QR + caducidad', async () => {
    const r = await call('GET', '/pairing/whatsapp', { bearer: await token({ sub: A }) });
    expect(r.status).toBe(200);
    expect(r.json.state).toBe('paired');
    expect(r.json.sessionKey).toBe(A);
    expect(poolCalls).toEqual([
      { channel: 'whatsapp', route: 'state', sessionKey: A, signatureOk: true },
    ]);
  });

  it('GET /me/whatsapp of A returns A jid, of B returns B jid — never the other', async () => {
    const ra = await call('GET', '/me/whatsapp', { bearer: await token({ sub: A }) });
    expect(ra.status).toBe(200);
    expect(ra.json).toEqual({ jid: PAIRED[A].jid });
    const rb = await call('GET', '/me/whatsapp', { bearer: await token({ sub: B }) });
    expect(rb.status).toBe(200);
    expect(rb.json).toEqual({ jid: PAIRED[B].jid });
    expect(ra.json.jid).not.toBe(rb.json.jid);
    const rc = await call('GET', '/me/whatsapp', { bearer: await token({ sub: C }) });
    expect(rc.status).toBe(404);
    expect(rc.json).toEqual({ error: 'not_paired' });
  });

  it('pool 503 → 503 pairing_unavailable', async () => {
    const r = await call('POST', '/pairing/whatsapp/start', {
      bearer: await token({ sub: 'pool503' }),
    });
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: 'pairing_unavailable' });
  });

  it('pool 429 → 429 with Retry-After passed through', async () => {
    const r = await call('POST', '/pairing/whatsapp/start', {
      bearer: await token({ sub: 'pool429' }),
    });
    expect(r.status).toBe(429);
    expect(r.json.error).toBe('rate_limited');
    expect(r.json.reason).toBe('start_interval');
    expect(r.headers.get('retry-after')).toBe('61');
  });

  it('malformed JSON body → 400 invalid_json (after auth, before the pool)', async () => {
    const bearer = await token();
    const res = await fetch(`${appBase}/pairing/whatsapp/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: '{oops',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
    expect(poolCalls).toHaveLength(0);
  });
});

describe('social-api hardening (Origin and cross-sub)', () => {
  beforeAll(async () => {
    await serve();
  });

  it('present Origin outside the (empty) allowlist → 403, no pool call', async () => {
    const r = await call('POST', '/pairing/whatsapp/start', {
      bearer: await token(),
      origin: 'https://evil.example',
    });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'forbidden_origin' });
    expect(poolCalls).toHaveLength(0);
  });

  it('Origin inside SOCIAL_API_ALLOWED_ORIGINS → allowed', async () => {
    await serve({ allowedOrigins: ['https://messages.e-dani.com'] });
    const r = await call('GET', '/pairing/whatsapp', {
      bearer: await token({ sub: A }),
      origin: 'https://messages.e-dani.com',
    });
    expect(r.status).toBe(200);
    await serve();
  });

  it('social-api never answers CORS headers', async () => {
    const r = await call('GET', '/pairing/whatsapp', { bearer: await token({ sub: A }) });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('foreign sub/sessionKey/jid in body or query → 403, no pool call', async () => {
    const bearer = await token({ sub: A });
    const inBody = await call('POST', '/pairing/whatsapp/start', {
      bearer,
      body: { sessionKey: B },
    });
    expect(inBody.status).toBe(403);
    expect(inBody.json).toEqual({ error: 'forbidden_identity' });
    const subInBody = await call('POST', '/pairing/whatsapp/start', { bearer, body: { sub: B } });
    expect(subInBody.status).toBe(403);
    const inQuery = await call('GET', '/pairing/whatsapp?sessionKey=' + B, { bearer });
    expect(inQuery.status).toBe(403);
    const jidInQuery = await call('GET', '/me/whatsapp?jid=' + encodeURIComponent(PAIRED[B].jid), {
      bearer,
    });
    expect(jidInQuery.status).toBe(403);
    expect(poolCalls).toHaveLength(0);
  });

  it('own sub in body or query is accepted and ignored (pool still gets the JWT sub)', async () => {
    const bearer = await token({ sub: A });
    const r = await call('POST', '/pairing/whatsapp/start', { bearer, body: { sub: A } });
    expect(r.status).toBe(200);
    expect(poolCalls).toEqual([
      { channel: 'whatsapp', route: 'start', sessionKey: A, signatureOk: true },
    ]);
  });

  it('invented sub without a token: 401 and ZERO rows in the store', async () => {
    const before = storeRows.size;
    const r = await call('POST', '/pairing/whatsapp/start', {
      body: { sessionKey: 'ffffffff-dead-beef-0000-000000000000' },
    });
    expect(r.status).toBe(401);
    expect(poolCalls).toHaveLength(0);
    expect(storeRows.size).toBe(before);
  });
});

describe('social-api gates (flag off, store off)', () => {
  it('SOCIAL_PAIRING_API=off: 404 for everything but /health', async () => {
    await serve({ apiEnabled: false, whatsappPairing: null, telegramPairing: null });
    const h = await call('GET', '/health');
    expect(h.status).toBe(200);
    expect(h.json.pairingApi).toBe('off');
    const bearer = await token();
    const start = await call('POST', '/pairing/whatsapp/start', { bearer });
    expect(start.status).toBe(404);
    expect(start.json).toEqual({ error: 'not_found' });
    const me = await call('GET', '/me/whatsapp', { bearer });
    expect(me.status).toBe(404);
    // SC-1229: the telegram routes are off with the same flag
    const tgStart = await call('POST', '/pairing/telegram/start', { bearer });
    expect(tgStart.status).toBe(404);
    expect(tgStart.json).toEqual({ error: 'not_found' });
    const tgMe = await call('GET', '/me/telegram', { bearer });
    expect(tgMe.status).toBe(404);
    const tgPw = await call('POST', '/pairing/telegram/password', {
      bearer,
      body: { password: 'x' },
    });
    expect(tgPw.status).toBe(404);
    expect(poolCalls).toHaveLength(0);
  });

  it('store off → 503 pairing_unavailable on /pairing/* and /me/*', async () => {
    await serve({ storeAvailable: false });
    const bearer = await token();
    const r = await call('GET', '/pairing/whatsapp', { bearer });
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: 'pairing_unavailable' });
    const m = await call('GET', '/me/whatsapp', { bearer });
    expect(m.status).toBe(503);
    // SC-1229: the store gate covers the telegram routes too (per-pool, but
    // a dead store kills both)
    const tg = await call('GET', '/pairing/telegram', { bearer });
    expect(tg.status).toBe(503);
    expect(tg.json).toEqual({ error: 'pairing_unavailable' });
    const tgM = await call('GET', '/me/telegram', { bearer });
    expect(tgM.status).toBe(503);
    expect(poolCalls).toHaveLength(0);
  });

  it('no HMAC secret / no pool URL → 503 pairing_unavailable', async () => {
    await serve({ whatsappPairing: null });
    const r = await call('GET', '/me/whatsapp', { bearer: await token() });
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: 'pairing_unavailable' });
    // and the telegram routes are UNAFFECTED — separate client, separate
    // gate (architect note on the SC-1228 storeGate: pools never inherit)
    const tg = await call('GET', '/me/telegram', { bearer: await token({ sub: A }) });
    expect(tg.status).toBe(200);
    expect(tg.json).toEqual({ id: TG[A].id, username: TG[A].username });
    await serve({ telegramPairing: null });
    const tgd = await call('GET', '/me/telegram', { bearer: await token({ sub: A }) });
    expect(tgd.status).toBe(503);
    expect(tgd.json).toEqual({ error: 'pairing_unavailable' });
    const wa = await call('GET', '/me/whatsapp', { bearer: await token({ sub: A }) });
    expect(wa.status).toBe(200);
    await serve();
  });

  it('unknown path with a valid token → 404 not_found', async () => {
    await serve();
    const r = await call('GET', '/nope', { bearer: await token() });
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: 'not_found' });
  });
});

describe('social-api GET /social/status (SC-1228)', () => {
  beforeAll(async () => {
    await serve();
  });

  it('A and B: each token sees only its own channels, zero identifiers in the body', async () => {
    const ra = await call('GET', '/social/status', { bearer: await token({ sub: A }) });
    expect(ra.status).toBe(200);
    expect(ra.json.channels).toEqual({
      whatsapp: { state: 'paired' },
      // SC-1229: the telegram state is REAL now — the pool answers it.
      telegram: { state: 'paired' },
      instagram: { state: 'paired' },
    });
    const rb = await call('GET', '/social/status', { bearer: await token({ sub: B }) });
    expect(rb.status).toBe(200);

    // grep-level isolation: no identifier of B anywhere in A's body, and
    // vice versa — not even the caller's own sub or a jid key (structural:
    // the response carries states and house account names, nothing else).
    const bodyA = JSON.stringify(ra.json);
    const bodyB = JSON.stringify(rb.json);
    expect(bodyA).not.toContain(PAIRED[B].jid);
    expect(bodyA).not.toContain(IG[B].username);
    expect(bodyA).not.toContain(TG[B].username || '');
    expect(bodyA).not.toContain(TG[B].id);
    expect(bodyA).not.toContain(B);
    expect(bodyB).not.toContain(PAIRED[A].jid);
    expect(bodyB).not.toContain(IG[A].username);
    expect(bodyB).not.toContain(TG[A].username || '');
    expect(bodyB).not.toContain(TG[A].id);
    expect(bodyB).not.toContain(A);
    expect(bodyA).not.toContain('jid');
    expect(bodyA).not.toContain(A);

    // every read was keyed by the caller's own sub, nothing was listed:
    // two pool reads per status call (whatsapp state + telegram state)
    expect(poolCalls.map(c => `${c.channel}:${c.route}:${c.sessionKey}`).sort()).toEqual(
      [
        `telegram:state:${A}`,
        `telegram:state:${B}`,
        `whatsapp:state:${A}`,
        `whatsapp:state:${B}`,
      ].sort()
    );
    expect(fakeStore.reads).toEqual([
      { sessionKey: A, channel: 'instagram' },
      { sessionKey: B, channel: 'instagram' },
    ]);
  });

  it('whatsapp states: no row → unpaired, provider-invalidated → expired, pairing in flight → unpaired', async () => {
    const none = await call('GET', '/social/status', { bearer: await token({ sub: C }) });
    expect(chan(none).whatsapp).toEqual({ state: 'unpaired' });
    expect(chan(none).instagram).toEqual({ state: 'unpaired' });
    const expired = await call('GET', '/social/status', {
      bearer: await token({ sub: 'expiredwa' }),
    });
    expect(chan(expired).whatsapp).toEqual({ state: 'expired' });
    const inFlight = await call('GET', '/social/status', { bearer: await token({ sub: 'qrsub' }) });
    expect(chan(inFlight).whatsapp).toEqual({ state: 'unpaired' });
  });

  it('telegram states (SC-1229): same reading — row → paired, invalidated → expired, in flight (qr, password) → unpaired, no row → unpaired', async () => {
    const paired = await call('GET', '/social/status', { bearer: await token({ sub: A }) });
    expect(chan(paired).telegram).toEqual({ state: 'paired' });
    const none = await call('GET', '/social/status', { bearer: await token({ sub: C }) });
    expect(chan(none).telegram).toEqual({ state: 'unpaired' });
    const expired = await call('GET', '/social/status', {
      bearer: await token({ sub: 'expiredtg' }),
    });
    expect(chan(expired).telegram).toEqual({ state: 'expired' });
    const qr = await call('GET', '/social/status', { bearer: await token({ sub: 'qrtg' }) });
    expect(chan(qr).telegram).toEqual({ state: 'unpaired' });
    // the 2FA step is still a pairing in flight: unpaired, never paired
    const pw = await call('GET', '/social/status', { bearer: await token({ sub: 'passwordtg' }) });
    expect(chan(pw).telegram).toEqual({ state: 'unpaired' });
  });

  it('instagram states: expiresAt past → expired, legacy row → paired, broken row → unavailable', async () => {
    const past = await call('GET', '/social/status', { bearer: await token({ sub: 'igexpired' }) });
    expect(chan(past).instagram).toEqual({ state: 'expired' });
    const legacy = await call('GET', '/social/status', {
      bearer: await token({ sub: 'iglegacy' }),
    });
    expect(chan(legacy).instagram).toEqual({ state: 'paired' });
    const broken = await call('GET', '/social/status', {
      bearer: await token({ sub: 'igbroken' }),
    });
    expect(chan(broken).instagram).toEqual({ state: 'unavailable' });
  });

  it('pool down → whatsapp unavailable only; store stays independent', async () => {
    const down = await call('GET', '/social/status', { bearer: await token({ sub: 'pool503' }) });
    expect(down.status).toBe(200);
    expect(chan(down).whatsapp).toEqual({ state: 'unavailable' });
    expect(chan(down).instagram).toEqual({ state: 'unpaired' });
    const limited = await call('GET', '/social/status', {
      bearer: await token({ sub: 'pool429' }),
    });
    expect(chan(limited).whatsapp).toEqual({ state: 'unavailable' });
    // no pool URL configured at all
    await serve({ whatsappPairing: null });
    const unconfigured = await call('GET', '/social/status', { bearer: await token({ sub: A }) });
    expect(unconfigured.status).toBe(200);
    expect(chan(unconfigured).whatsapp).toEqual({ state: 'unavailable' });
    expect(chan(unconfigured).instagram).toEqual({ state: 'paired' });
    // SC-1229: the whatsapp pool being gone says NOTHING about telegram —
    // the other pool is still read and still answers paired.
    expect(chan(unconfigured).telegram).toEqual({ state: 'paired' });
    await serve({ telegramPairing: null });
    const tgUnconfigured = await call('GET', '/social/status', { bearer: await token({ sub: A }) });
    expect(chan(tgUnconfigured).telegram).toEqual({ state: 'unavailable' });
    expect(chan(tgUnconfigured).whatsapp).toEqual({ state: 'paired' });
    expect(chan(tgUnconfigured).instagram).toEqual({ state: 'paired' });
    await serve();
  });

  it('store off → 200 with every channel unavailable, not 503, and zero reads (D7)', async () => {
    await serve({ storeAvailable: false, credentialStore: null });
    const r = await call('GET', '/social/status', { bearer: await token({ sub: A }) });
    expect(r.status).toBe(200);
    expect(r.json.channels).toEqual({
      whatsapp: { state: 'unavailable' },
      telegram: { state: 'unavailable' },
      instagram: { state: 'unavailable' },
    });
    expect(poolCalls).toHaveLength(0);
    expect(fakeStore.reads).toHaveLength(0);
    // the pairing routes still 503 with the store off (P1b behavior kept)
    const pairing = await call('GET', '/pairing/whatsapp', { bearer: await token({ sub: A }) });
    expect(pairing.status).toBe(503);
    await serve();
  });

  it('houseAccounts: exactly the registry accounts bound to the caller', async () => {
    // Bindings are by accountId, channel-agnostic (same semantics as
    // resolveBoundAccount): 'professional' covers whatsapp AND telegram.
    const ra = await call('GET', '/social/status', { bearer: await token({ sub: A }) });
    expect(ra.json.houseAccounts).toEqual([
      { channel: 'whatsapp', accountId: 'professional', label: 'professional' },
      { channel: 'telegram', accountId: 'professional', label: 'professional' },
      { channel: 'instagram', accountId: 'skirmshop', label: 'skirmshop' },
    ]);
    const rb = await call('GET', '/social/status', { bearer: await token({ sub: B }) });
    expect(rb.json.houseAccounts).toEqual([
      { channel: 'whatsapp', accountId: 'personal', label: 'personal' },
      { channel: 'telegram', accountId: 'personal', label: 'personal' },
    ]);
    const rc = await call('GET', '/social/status', { bearer: await token({ sub: C }) });
    expect(rc.json.houseAccounts).toEqual([]);
  });

  it('unreadable bindings table → houseAccounts [] fail-closed, status still 200', async () => {
    await serve({ identityBindingsPath: join(bindingsDir, 'missing.yaml') });
    const r = await call('GET', '/social/status', { bearer: await token({ sub: A }) });
    expect(r.status).toBe(200);
    expect(r.json.houseAccounts).toEqual([]);
    expect(chan(r).whatsapp).toEqual({ state: 'paired' });
    await serve();
  });

  it('gates: no JWT → 401 with zero pool calls and zero store reads; foreign Origin → 403; foreign sub/sessionKey in query → 403; flag off → 404', async () => {
    const noAuth = await call('GET', '/social/status');
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toBe('Bearer');
    expect(poolCalls).toHaveLength(0);
    expect(fakeStore.reads).toHaveLength(0);

    const origin = await call('GET', '/social/status', {
      bearer: await token({ sub: A }),
      origin: 'https://evil.example',
    });
    expect(origin.status).toBe(403);
    expect(origin.json).toEqual({ error: 'forbidden_origin' });

    const foreignSub = await call('GET', `/social/status?sub=${B}`, {
      bearer: await token({ sub: A }),
    });
    expect(foreignSub.status).toBe(403);
    expect(foreignSub.json).toEqual({ error: 'forbidden_identity' });
    const foreignKey = await call('GET', `/social/status?sessionKey=${B}`, {
      bearer: await token({ sub: A }),
    });
    expect(foreignKey.status).toBe(403);

    expect(poolCalls).toHaveLength(0);
    expect(fakeStore.reads).toHaveLength(0);

    await serve({
      apiEnabled: false,
      whatsappPairing: null,
      telegramPairing: null,
      credentialStore: null,
    });
    const off = await call('GET', '/social/status', { bearer: await token({ sub: A }) });
    expect(off.status).toBe(404);
    expect(off.json).toEqual({ error: 'not_found' });
    await serve();
  });
});

describe('social-api telegram pairing routes (SC-1229)', () => {
  beforeAll(async () => {
    await serve();
  });

  it('no token → 401 on every telegram route, ZERO pool calls', async () => {
    for (const [method, path] of [
      ['POST', '/pairing/telegram/start'],
      ['GET', '/pairing/telegram'],
      ['POST', '/pairing/telegram/password'],
      ['GET', '/me/telegram'],
    ] as const) {
      const r = await call(method, path);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect(poolCalls).toHaveLength(0);
  });

  it('A starts its own flow and receives the authorization step (QR + caducidad)', async () => {
    const r = await call('POST', '/pairing/telegram/start', { bearer: await token({ sub: C }) });
    expect(r.status).toBe(200);
    expect(r.json.state).toBe('qr');
    const qr = r.json.qr as Record<string, unknown>;
    expect(typeof qr.value).toBe('string');
    expect(typeof qr.dataUrl).toBe('string');
    expect(new Date(String(qr.expiresAt)).getTime()).toBeGreaterThan(Date.now());
    expect(poolCalls).toEqual([
      { channel: 'telegram', route: 'start', sessionKey: C, signatureOk: true },
    ]);
  });

  it('GET /pairing/telegram polls the states, including the password step', async () => {
    const pw = await call('GET', '/pairing/telegram', {
      bearer: await token({ sub: 'passwordtg' }),
    });
    expect(pw.status).toBe(200);
    expect(pw.json.state).toBe('password');
    const paired = await call('GET', '/pairing/telegram', { bearer: await token({ sub: A }) });
    expect(paired.status).toBe(200);
    expect(paired.json.state).toBe('paired');
    expect(paired.json.sessionKey).toBe(A);
  });

  it('A can never see B: /me/telegram of A is A, of B is B, invented sub 404s', async () => {
    const ra = await call('GET', '/me/telegram', { bearer: await token({ sub: A }) });
    expect(ra.status).toBe(200);
    expect(ra.json).toEqual({ id: TG[A].id, username: TG[A].username });
    const rb = await call('GET', '/me/telegram', { bearer: await token({ sub: B }) });
    expect(rb.status).toBe(200);
    expect(rb.json).toEqual({ id: TG[B].id, username: TG[B].username });
    expect(ra.json.username).not.toBe(rb.json.username);
    const invented = await call('GET', '/me/telegram', {
      bearer: await token({ sub: 'ffffffff-dead-beef-0000-000000000000' }),
    });
    expect(invented.status).toBe(404);
    expect(invented.json).toEqual({ error: 'not_paired' });
    // the body of A's answer carries nothing of B
    expect(JSON.stringify(ra.json)).not.toContain(TG[B].id);
    expect(JSON.stringify(ra.json)).not.toContain(TG[B].username || 'bea_tg');
  });

  it('2FA: password completes the flow (200), passthrough of the pool 409, own 400 validation', async () => {
    const ok = await call('POST', '/pairing/telegram/password', {
      bearer: await token({ sub: 'pwsub' }),
      body: { password: 'correct horse' },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.state).toBe('paired');
    expect(ok.json.me).toEqual(TG.pwsub);
    expect(poolCalls).toEqual([
      { channel: 'telegram', route: 'password', sessionKey: 'pwsub', signatureOk: true },
    ]);

    const notWaiting = await call('POST', '/pairing/telegram/password', {
      bearer: await token({ sub: A }),
      body: { password: 'x' },
    });
    expect(notWaiting.status).toBe(409);
    expect(notWaiting.json).toEqual({ error: 'password_not_requested' });

    // social-api's own validation runs BEFORE the pool: missing, empty and
    // over-long passwords are 400 invalid_password with zero NEW pool calls.
    const before = poolCalls.length;
    for (const body of [{}, { password: '' }, { password: 'x'.repeat(1025) }, { password: 123 }]) {
      const bad = await call('POST', '/pairing/telegram/password', {
        bearer: await token({ sub: A }),
        body,
      });
      expect(bad.status).toBe(400);
      expect(bad.json).toEqual({ error: 'invalid_password' });
    }
    expect(poolCalls).toHaveLength(before);
  });

  it('pool errors pass through: 503 pairing_unavailable, 429 with Retry-After', async () => {
    const down = await call('POST', '/pairing/telegram/start', {
      bearer: await token({ sub: 'pool503' }),
    });
    expect(down.status).toBe(503);
    expect(down.json).toEqual({ error: 'pairing_unavailable' });
    const limited = await call('POST', '/pairing/telegram/start', {
      bearer: await token({ sub: 'pool429' }),
    });
    expect(limited.status).toBe(429);
    expect(limited.json.error).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toBe('61');
  });

  it('identity gates: foreign sessionKey/sub in body → 403 with zero pool calls; own sub accepted', async () => {
    const bearer = await token({ sub: A });
    const foreign = await call('POST', '/pairing/telegram/start', {
      bearer,
      body: { sessionKey: B },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.json).toEqual({ error: 'forbidden_identity' });
    const foreignQuery = await call('GET', '/pairing/telegram?sessionKey=' + B, { bearer });
    expect(foreignQuery.status).toBe(403);
    const pwForeign = await call('POST', '/pairing/telegram/password', {
      bearer,
      body: { sub: B, password: 'x' },
    });
    expect(pwForeign.status).toBe(403);
    expect(poolCalls).toHaveLength(0);
    // own sub is accepted and ignored: the pool receives the JWT sub
    const own = await call('POST', '/pairing/telegram/start', { bearer, body: { sub: A } });
    expect(own.status).toBe(200);
    expect(poolCalls).toEqual([
      { channel: 'telegram', route: 'start', sessionKey: A, signatureOk: true },
    ]);
  });

  it('Origin gate applies to the telegram routes too', async () => {
    const r = await call('POST', '/pairing/telegram/start', {
      bearer: await token({ sub: A }),
      origin: 'https://evil.example',
    });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'forbidden_origin' });
    expect(poolCalls).toHaveLength(0);
  });
});

describe('jwtVerifierConfigFromEnv defaults (spec point 1)', () => {
  it('empty env yields the spec defaults', () => {
    const cfg = jwtVerifierConfigFromEnv({});
    expect(cfg.issuer).toBe('https://auth-next.e-dani.com/realms/edani');
    expect(cfg.jwksUrl).toBe(
      'http://keycloak.keycloak.svc.cluster.local/realms/edani/protocol/openid-connect/certs'
    );
    expect(cfg.audience).toBe('social-api');
    expect(cfg.allowedAzp).toEqual(['dgx-messages']);
    expect(cfg.clockToleranceSeconds).toBe(30);
  });

  it('env overrides are read verbatim and azp accepts a comma list', () => {
    const cfg = jwtVerifierConfigFromEnv({
      SOCIAL_API_JWT_ISSUER: 'https://iss.example/realms/r',
      SOCIAL_API_JWKS_URL: 'http://jwks.example/certs',
      SOCIAL_API_JWT_AUDIENCE: 'other-api',
      SOCIAL_API_ALLOWED_AZP: 'dgx-messages, another-azp ',
    });
    expect(cfg.issuer).toBe('https://iss.example/realms/r');
    expect(cfg.jwksUrl).toBe('http://jwks.example/certs');
    expect(cfg.audience).toBe('other-api');
    expect(cfg.allowedAzp).toEqual(['dgx-messages', 'another-azp']);
  });
});
