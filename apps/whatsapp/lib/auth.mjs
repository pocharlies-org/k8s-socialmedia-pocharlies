import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as oidcDefault from 'openid-client';
import { fail, authenticate as basicAuthenticate } from './security.mjs';

const SESSION_COOKIE = '__Host-wa_session';
const TRANSACTION_COOKIE = '__Host-wa_oidc_tx';
const LOGIN_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 1024;
const MAX_TRANSACTIONS = 128;
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function parseCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return null; }
  }
  return null;
}

function cookie(name, value, { maxAge, secure = true } = {}) {
  const attributes = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) attributes.push('Secure');
  if (maxAge !== undefined) attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return attributes.join('; ');
}

function clearCookie(name, secure = true) {
  return cookie(name, '', { maxAge: 0, secure });
}

function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\0')) return '/';
  try {
    const parsed = new URL(value, 'https://whatsapp.invalid');
    if (parsed.origin !== 'https://whatsapp.invalid') return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

function parseAllowedSubjects(value) {
  const subjects = String(value || '').split(',').map(subject => subject.trim()).filter(Boolean);
  if (!subjects.length) throw Error('OIDC_ALLOWED_SUBJECTS is required in OIDC mode');
  return new Set(subjects);
}

function sessionTtlSeconds(value) {
  if (value === undefined || value === '') return DEFAULT_SESSION_TTL_SECONDS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > DEFAULT_SESSION_TTL_SECONDS) throw Error('OIDC_SESSION_TTL_SECONDS must be an integer between 1 and 2592000');
  return parsed;
}

function modeFor(env) {
  const configured = String(env.APP_AUTH_MODE || '').trim().toLowerCase();
  if (configured) return configured;
  return nonEmpty(env.OIDC_ISSUER_URL) ? 'oidc' : 'basic';
}

function sessionId() {
  return randomBytes(32).toString('base64url');
}

function trimExpired(map, now) {
  for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
}

function boundedInsert(map, key, value, limit) {
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

/**
 * App authentication supports explicit Basic mode for local compatibility and
 * an OIDC mode whose only accepted identity is the configured subject allowlist.
 */
export class AppAuth {
  constructor({ env = process.env, fetchImpl = fetch, oidc = oidcDefault, now = () => Date.now() } = {}) {
    this.env = env;
    this.mode = modeFor(env);
    this.fetchImpl = fetchImpl;
    this.oidc = oidc;
    this.now = now;
    this.sessions = new Map();
    this.transactions = new Map();
    this.configPromise = null;
    this.sessionStorePath = null;
    this.pendingSave = Promise.resolve();

    if (!['basic', 'oidc'].includes(this.mode)) throw Error('APP_AUTH_MODE must be basic or oidc');
    if (!nonEmpty(env.APP_PUBLIC_URL)) throw Error('APP_PUBLIC_URL is required');
    if (this.mode === 'basic') {
      if (!nonEmpty(env.UI_AUTH_USERNAME) || !nonEmpty(env.UI_AUTH_PASSWORD)) throw Error('UI authentication credentials are required in basic mode');
      return;
    }
    if (!nonEmpty(env.OIDC_ISSUER_URL) || !nonEmpty(env.OIDC_CLIENT_ID) || !nonEmpty(env.OIDC_CLIENT_SECRET)) throw Error('OIDC issuer, client ID, and client secret are required in OIDC mode');
    try { this.issuer = new URL(env.OIDC_ISSUER_URL); } catch { throw Error('OIDC_ISSUER_URL must be an absolute URL'); }
    if (this.issuer.protocol !== 'https:') throw Error('OIDC_ISSUER_URL must use HTTPS');
    this.clientId = env.OIDC_CLIENT_ID;
    this.clientSecret = env.OIDC_CLIENT_SECRET;
    this.allowedSubjects = parseAllowedSubjects(env.OIDC_ALLOWED_SUBJECTS);
    this.sessionTtlSeconds = sessionTtlSeconds(env.OIDC_SESSION_TTL_SECONDS);
    this.publicUrl = new URL(env.APP_PUBLIC_URL);
    if (this.publicUrl.protocol !== 'https:') throw Error('APP_PUBLIC_URL must use HTTPS in OIDC mode');
    this.callbackUrl = new URL('/auth/callback', this.publicUrl).href;
  }

  get oidcEnabled() { return this.mode === 'oidc'; }

  async init(dataDir) {
    if (!this.oidcEnabled) return;
    const authDir = join(dataDir, 'auth');
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    await chmod(authDir, 0o700);
    this.sessionStorePath = join(authDir, 'oidc-sessions.json');
    let stored;
    try { stored = JSON.parse(await readFile(this.sessionStorePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!Array.isArray(stored?.sessions)) throw Error('Invalid OIDC session store');
    const now = this.now();
    for (const entry of stored.sessions) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, session] = entry;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id) ||
          !this.allowedSubjects.has(session?.subject) || !Number.isFinite(session?.expiresAt) ||
          session.expiresAt <= now || session.expiresAt > now + this.sessionTtlSeconds * 1000) continue;
      boundedInsert(this.sessions, id, session, MAX_SESSIONS);
    }
  }

  async saveSessions() {
    if (!this.sessionStorePath) return;
    const path = this.sessionStorePath;
    const contents = JSON.stringify({ sessions: [...this.sessions] });
    this.pendingSave = this.pendingSave.catch(() => {}).then(async () => {
      const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
      await writeFile(temp, contents, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, path);
    });
    await this.pendingSave;
  }

  async configuration() {
    if (!this.oidcEnabled) throw Error('OIDC is not enabled');
    if (!this.configPromise) {
      const options = { execute: [] };
      if (typeof this.oidc.enableNonRepudiationChecks === 'function') options.execute.push(this.oidc.enableNonRepudiationChecks);
      if (this.oidc.customFetch) options[this.oidc.customFetch] = (url, requestOptions) => this.fetchImpl(url, requestOptions);
      this.configPromise = this.oidc.discovery(this.issuer, this.clientId, this.clientSecret, this.oidc.ClientSecretBasic?.(this.clientSecret), options)
        .catch(error => { this.configPromise = null; throw error; });
    }
    try { return await this.configPromise; } catch { throw fail(503, 'Identity provider unavailable'); }
  }

  isAuthenticated(req) {
    if (this.mode === 'basic') return basicAuthenticate(req.headers.authorization, this.env) ? { subject: 'basic' } : null;
    const now = this.now();
    trimExpired(this.sessions, now);
    const id = parseCookie(req.headers.cookie, SESSION_COOKIE);
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= now) {
      this.sessions.delete(id);
      return null;
    }
    session.lastSeenAt = now;
    return { subject: session.subject, sessionId: id, expiresAt: session.expiresAt };
  }

  async beginLogin(returnTo = '/') {
    if (!this.oidcEnabled) throw fail(404, 'Not found');
    const config = await this.configuration();
    const verifier = this.oidc.randomPKCECodeVerifier();
    const challenge = await this.oidc.calculatePKCECodeChallenge(verifier);
    const state = this.oidc.randomState();
    const nonce = this.oidc.randomNonce();
    const now = this.now();
    boundedInsert(this.transactions, state, { verifier, nonce, returnTo: safeReturnTo(returnTo), createdAt: now, expiresAt: now + LOGIN_TRANSACTION_TTL_MS }, MAX_TRANSACTIONS);
    trimExpired(this.transactions, now);
    const redirect = this.oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.callbackUrl,
      response_type: 'code',
      scope: 'openid profile email',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { location: redirect.href, setCookie: cookie(TRANSACTION_COOKIE, state, { maxAge: LOGIN_TRANSACTION_TTL_MS / 1000 }) };
  }

  async finishLogin(currentUrl, transactionCookie) {
    if (!this.oidcEnabled) throw fail(404, 'Not found');
    const state = currentUrl.searchParams.get('state');
    if (!state || !transactionCookie || state !== transactionCookie) throw fail(400, 'Invalid authentication response');
    const transaction = this.transactions.get(state);
    this.transactions.delete(state);
    if (!transaction || transaction.expiresAt <= this.now()) throw fail(400, 'Authentication request expired');
    if (currentUrl.searchParams.has('error')) throw fail(400, 'Authentication failed');
    const config = await this.configuration();
    let tokens;
    try {
      tokens = await this.oidc.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: transaction.verifier,
        expectedState: state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      }, { redirect_uri: this.callbackUrl });
    } catch {
      throw fail(400, 'Authentication failed');
    }
    let claims;
    try { claims = tokens.claims(); } catch { throw fail(400, 'Authentication failed'); }
    const subject = claims?.sub;
    if (!nonEmpty(subject) || !this.allowedSubjects.has(subject)) throw fail(403, 'Account is not authorized');
    const id = sessionId();
    const now = this.now();
    boundedInsert(this.sessions, id, { subject, createdAt: now, lastSeenAt: now, expiresAt: now + this.sessionTtlSeconds * 1000 }, MAX_SESSIONS);
    trimExpired(this.sessions, now);
    await this.saveSessions();
    return {
      location: transaction.returnTo,
      setCookie: [cookie(SESSION_COOKIE, id, { maxAge: this.sessionTtlSeconds }), clearCookie(TRANSACTION_COOKIE)],
    };
  }

  async logout(req) {
    if (this.mode === 'oidc') {
      const id = parseCookie(req.headers.cookie, SESSION_COOKIE);
      if (id) this.sessions.delete(id);
      await this.saveSessions();
      return { setCookie: clearCookie(SESSION_COOKIE) };
    }
    return { setCookie: null };
  }
}

export { SESSION_COOKIE, TRANSACTION_COOKIE, clearCookie, cookie, parseCookie, safeReturnTo };
