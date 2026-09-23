/**
 * SC-1194 P1 (SC-1143): Instagram pairing per `sub` on the credential store.
 *
 * CTO ruling (nota-cto-decision-instagram-login, 23-09): the per-user pairing
 * goes through "Instagram API with Instagram Login" (Business Login,
 * graph.instagram.com) — Meta's standard OAuth flow, NOT a custom client. The
 * only home-grown part is WHERE the token lands afterwards: the SC-705 store,
 * keyed by the gateway-verified `sub` (session_key = `<sub>`, or
 * `<sub>:<cuenta>` for a second account — the tech-lead convention from
 * credential-session.ts, same charset rule).
 *
 * Flow (https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login):
 *   1. authorize  GET https://www.instagram.com/oauth/authorize
 *                 ?client_id&redirect_uri&scope&response_type=code&state
 *   2. code       POST https://api.instagram.com/oauth/access_token
 *                 form: client_id, client_secret, grant_type=authorization_code,
 *                       redirect_uri, code            → short-lived (1 h) token
 *   3. long-lived GET graph.instagram.com/v21.0/access_token
 *                 ?grant_type=ig_exchange_token&client_secret&access_token
 *                 → 60 days; we REJECT anything under 5.184.000 s (criterion 3
 *                 of the epic: never store a token that will die in an hour).
 *   4. identity   GET graph.instagram.com/v21.0/me?fields=id,user_id,username
 *   5. store.put  envelope-encrypted payload (credential-store does the crypto)
 *
 * The `state` parameter carries the pairing identity across the browser
 * round-trip: `<sub>[/<label>]` signed with an HMAC derived from
 * CREDENTIAL_STORE_MASTER_KEY (HKDF domain-separated, so the state key can
 * never be the data-key itself) and short-lived. The exchange runs
 * server-side only — the client_secret never reaches the browser.
 *
 * Refresh (criterion 3): GET graph.instagram.com/v21.0/refresh_access_token
 * ?grant_type=ig_refresh_token — Meta requires the token to be at least 24 h
 * old; a refreshed token is valid 60 days again. `refreshInstagramToken` is
 * the primitive; credential-resolution.ts wires refresh-on-use.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';
import {
  CredentialStore,
  InstagramTokenPayload,
  StoredCredential,
  credentialMasterKeyFromEnv,
  deserializeInstagramToken,
  serializeInstagramToken,
} from '@mcp-socialmedia/shared';

const IG_API_BASE = 'https://graph.instagram.com/v21.0';
const CODE_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
export const IG_AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';

/** The two scopes the CTO ruling pins for pairing (basic + publish). */
export const IG_PAIRING_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
] as const;

/** 60 days — the long-lived token the epic's criterion 3 demands. */
export const IG_MIN_LONG_LIVED_EXPIRES_IN = 5_184_000;

/** Meta: only tokens at least 24 h old may be refreshed. */
export const IG_REFRESH_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** Refresh-on-use threshold: renew once 14 days (or less) remain. */
export const IG_REFRESH_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;

/** session_key charset — mirrors CREDENTIAL_SESSION_KEY_RE (whatsapp-web). */
export const IG_SESSION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** Injectable fetch: tests hand in a fake of Meta; production uses global fetch. */
export interface PairingResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}
export type PairingFetch = (url: string, init?: Record<string, unknown>) => Promise<PairingResponse>;

export interface InstagramLoginConfig {
  /** The Instagram app id (App Dashboard → Instagram Login → Instagram App ID). */
  clientId: string;
  /** The Instagram app secret used for the server-side exchanges. */
  clientSecret: string;
  /** Registered redirect URI — must match the app's Valid OAuth Redirect URIs. */
  redirectUri: string;
  /** HMAC key for `state` (derived, never the master key itself). */
  stateSecret: Buffer;
}

/**
 * Derive the state-signing key from the credential-store master key with a
 * domain separator (HKDF). Same source of truth as the envelope encryption:
 * no extra secret to provision, and the signing key is not the data key.
 */
export function deriveStateSecret(masterKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', masterKey, Buffer.from('x86-socialmedia:v1'), Buffer.from('instagram-pairing-state/v1'), 32)
  );
}

/**
 * Pairing config from env, or null when pairing cannot run (flag off, no
 * master key, or missing app credentials). Credentials resolve IG-first:
 * INSTAGRAM_LOGIN_APP_ID / INSTAGRAM_LOGIN_APP_SECRET when the operator has
 * provisioned the Instagram Login pair, falling back to FACEBOOK_APP_ID /
 * FACEBOOK_APP_SECRET (the marketing-manager app — see 50-entrega.md for the
 * caveat that the Instagram Login secret may differ from the FB one).
 */
export function instagramLoginConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): InstagramLoginConfig | null {
  if (env.CREDENTIAL_STORE_ENABLED !== 'true') return null;
  const clientId = (env.INSTAGRAM_LOGIN_APP_ID || env.FACEBOOK_APP_ID || '').trim();
  const clientSecret = (env.INSTAGRAM_LOGIN_APP_SECRET || env.FACEBOOK_APP_SECRET || '').trim();
  const redirectUri = (env.INSTAGRAM_OAUTH_REDIRECT_URI || '').trim();
  const masterKey = credentialMasterKeyFromEnv(env);
  if (!clientId || !clientSecret || !redirectUri || !masterKey) return null;
  return { clientId, clientSecret, redirectUri, stateSecret: deriveStateSecret(masterKey) };
}

// ── state ────────────────────────────────────────────────────────────────

export interface PairingState {
  sub: string;
  /** Optional account label for a second account (`<sub>:<label>`). */
  label?: string;
  /** Epoch ms after which the authorize link is dead. */
  exp: number;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function stateMac(payloadB64: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(`ig-pairing-v1.${payloadB64}`).digest();
}

/** Sign the pairing state: `v1.<payload>.<mac>`, default 10 min validity. */
export function signPairingState(
  state: PairingState,
  secret: Buffer,
  now: number = Date.now(),
  ttlMs = 10 * 60 * 1000
): string {
  const payloadB64 = b64url(JSON.stringify({ ...state, exp: state.exp || now + ttlMs }));
  return `v1.${payloadB64}.${b64url(stateMac(payloadB64, secret))}`;
}

/** Verify + decode the pairing state. Tampered or expired → null. */
export function verifyPairingState(
  state: string,
  secret: Buffer,
  now: number = Date.now()
): PairingState | null {
  const parts = typeof state === 'string' ? state.split('.') : [];
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = stateMac(parts[1], secret);
  let actual: Buffer;
  try {
    actual = b64urlDecode(parts[2]);
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch {
    return null;
  }
  const value = decoded as Partial<PairingState>;
  if (typeof value.sub !== 'string' || !IG_SESSION_KEY_RE.test(value.sub)) return null;
  if (typeof value.exp !== 'number' || value.exp <= now) return null;
  if (value.label !== undefined && (typeof value.label !== 'string' || !IG_SESSION_KEY_RE.test(value.label))) {
    return null;
  }
  return { sub: value.sub, label: value.label, exp: value.exp };
}

/** The authorize URL the user opens from chat (criterion 2, step 1). */
export function buildAuthorizeUrl(config: InstagramLoginConfig, state: string): string {
  const url = new URL(IG_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', IG_PAIRING_SCOPES.join(','));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

// ── token exchanges (server-side; the secret never leaves the pod) ───────

async function readJsonError(response: PairingResponse, context: string): Promise<never> {
  let detail = '';
  try {
    detail = (await response.json ? JSON.stringify(await response.json()) : '') ?? '';
  } catch {
    /* keep empty */
  }
  throw new Error(`${context} failed (${response.status}): ${detail.slice(0, 500)}`);
}

/** Step 2: authorization code → short-lived (1 h) user token. */
export async function exchangeAuthorizationCode(
  code: string,
  config: InstagramLoginConfig,
  fetchImpl: PairingFetch
): Promise<{ accessToken: string; userId?: string }> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
    code,
  });
  const response = await fetchImpl(CODE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) await readJsonError(response, 'instagram code exchange');
  const data = (await response.json()) as { access_token?: string; user_id?: string | number };
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('instagram code exchange returned no access_token');
  }
  return { accessToken: data.access_token, userId: data.user_id === undefined ? undefined : String(data.user_id) };
}

/**
 * Step 3: short-lived → 60-day long-lived token (criterion 3). A response
 * under IG_MIN_LONG_LIVED_EXPIRES_IN is REJECTED — storing a 1 h token would
 * pair an account that silently dies before the user's first post.
 */
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
  config: InstagramLoginConfig,
  fetchImpl: PairingFetch
): Promise<{ accessToken: string; expiresIn: number; expiresAt: number }> {
  const url = new URL(`${IG_API_BASE}/access_token`);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', config.clientSecret);
  url.searchParams.set('access_token', shortLivedToken);
  const response = await fetchImpl(url.toString());
  if (!response.ok) await readJsonError(response, 'instagram long-lived exchange');
  const data = (await response.json()) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('instagram long-lived exchange returned no access_token');
  }
  if (typeof data.expires_in !== 'number' || data.expires_in < IG_MIN_LONG_LIVED_EXPIRES_IN) {
    throw new Error(
      `instagram long-lived exchange returned expires_in=${data.expires_in}; refusing tokens under ${IG_MIN_LONG_LIVED_EXPIRES_IN}s (60 days)`
    );
  }
  const now = Date.now();
  return { accessToken: data.access_token, expiresIn: data.expires_in, expiresAt: now + data.expires_in * 1000 };
}

/** Step 4: identity of the paired account (id + username for the payload). */
export async function fetchInstagramIdentity(
  accessToken: string,
  fetchImpl: PairingFetch
): Promise<{ id: string; userId?: string; username: string }> {
  const url = new URL(`${IG_API_BASE}/me`);
  url.searchParams.set('fields', 'id,user_id,username');
  url.searchParams.set('access_token', accessToken);
  const response = await fetchImpl(url.toString());
  if (!response.ok) await readJsonError(response, 'instagram identity lookup');
  const data = (await response.json()) as { id?: string; user_id?: string | number; username?: string };
  if (!data || typeof data.id !== 'string' || !data.id || typeof data.username !== 'string' || !data.username) {
    throw new Error('instagram identity lookup returned no id/username');
  }
  return { id: data.id, userId: data.user_id === undefined ? undefined : String(data.user_id), username: data.username };
}

/**
 * Criterion 3 refresh: renews a 60-day token (Meta: only when the token is at
 * least 24 h old and unexpired). Same expires_in floor as the exchange.
 */
export async function refreshInstagramToken(
  accessToken: string,
  fetchImpl: PairingFetch
): Promise<{ accessToken: string; expiresIn: number; expiresAt: number }> {
  const url = new URL(`${IG_API_BASE}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', accessToken);
  const response = await fetchImpl(url.toString());
  if (!response.ok) await readJsonError(response, 'instagram token refresh');
  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('instagram token refresh returned no access_token');
  }
  if (typeof data.expires_in !== 'number' || data.expires_in < IG_MIN_LONG_LIVED_EXPIRES_IN) {
    throw new Error(
      `instagram token refresh returned expires_in=${data.expires_in}; refusing tokens under ${IG_MIN_LONG_LIVED_EXPIRES_IN}s`
    );
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in, expiresAt: Date.now() + data.expires_in * 1000 };
}

// ── pairing orchestration ────────────────────────────────────────────────

export interface PairInstagramAccountDeps {
  code: string;
  state: string;
  config: InstagramLoginConfig;
  store: CredentialStore;
  fetchImpl: PairingFetch;
  now?: number;
}

export interface PairingResult {
  sessionKey: string;
  username: string;
  instagramUserId?: string;
}

/**
 * Decide the session_key for a freshly paired identity (tech-lead convention
 * `<sub>` / `<sub>:<cuenta>`):
 *  - explicit label (the user asked to pair a second account) → `<sub>:<label>`
 *  - no row under `<sub>` yet → `<sub>`
 *  - row under `<sub>` IS this same IG account → re-pairing: rotate in place
 *  - any other case → `<sub>:<username>`
 */
export function sessionKeyForPairing(
  sub: string,
  label: string | undefined,
  existingSubRow: StoredCredential | null,
  identity: { id: string; username: string }
): string {
  if (label) return `${sub}:${label}`;
  if (!existingSubRow) return sub;
  const existing = deserializeInstagramToken(existingSubRow.payload);
  if (existing.businessAccountId === identity.id) return sub;
  const byUsername = `${sub}:${identity.username}`;
  // A 36-char sub plus a 30-char username can overflow the 64-char key
  // convention; the IG account id (numeric, ~20 chars) never does.
  return IG_SESSION_KEY_RE.test(byUsername) ? byUsername : `${sub}:${identity.id}`;
}

/**
 * Full pairing round-trip after the callback received `code`+`state`:
 * verify state → code → short-lived → 60-day (floor enforced) → identity →
 * store.put under the sub's key. The payload goes through the store's
 * envelope encryption (never plaintext at rest); `accessToken` here is only
 * in memory.
 */
export async function pairInstagramAccount(deps: PairInstagramAccountDeps): Promise<PairingResult> {
  const now = deps.now ?? Date.now();
  const state = verifyPairingState(deps.state, deps.config.stateSecret, now);
  if (!state) {
    throw new Error('invalid or expired instagram pairing state');
  }
  const short = await exchangeAuthorizationCode(deps.code, deps.config, deps.fetchImpl);
  const long = await exchangeForLongLivedToken(short.accessToken, deps.config, deps.fetchImpl);
  const identity = await fetchInstagramIdentity(long.accessToken, deps.fetchImpl);

  const subRow = await deps.store.get(state.sub, 'instagram');
  const sessionKey = sessionKeyForPairing(state.sub, state.label, subRow, identity);
  if (!IG_SESSION_KEY_RE.test(sessionKey)) {
    throw new Error(`pairing would produce an invalid session_key: ${sessionKey.slice(0, 80)}`);
  }
  const payload: InstagramTokenPayload = serializeInstagramToken({
    accessToken: long.accessToken,
    businessAccountId: identity.id,
    instagramUserId: identity.userId,
    username: identity.username,
    expiresAt: long.expiresAt,
    issuedAt: now,
  });
  await deps.store.put(sessionKey, 'instagram', { ...payload });
  return { sessionKey, username: identity.username, instagramUserId: identity.userId };
}

/** Re-exported so callers can validate user-supplied account labels. */
export function newPairingNonce(): string {
  return randomBytes(8).toString('hex');
}
