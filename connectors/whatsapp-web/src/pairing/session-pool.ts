/**
 * SC-1225 (SC-1197 P1a, design D1): the per-sub baileys pool behind the
 * `whatsapp-pairing` Deployment.
 *
 * One BaileysClient per `sessionKey` (= the caller's Keycloak `sub`, fixed
 * by social-api from the verified JWT — this process never sees a JWT, it
 * trusts the HMAC-signed body). Properties the design pins:
 *
 *  - Persistence is ONLY the credential store (`user_channel_credentials`).
 *    The on-disk auth dir lives under SESSION_PATH (an in-memory emptyDir in
 *    k8s) and is rebuilt from the row on every start.
 *  - Lazy: nothing connects at boot. A socket exists only between a `start`
 *    and its eviction; `status`/`me` of a sub with no live socket read the
 *    row and never open one (a pod restart needs no QR to answer `me`).
 *  - The row is written only after the first `connection: open`
 *    (attachCredentialSession writeAfterFirstOpen) — an unscanned QR leaves
 *    no trace. `loggedOut` deletes the row and marks the sub `expired`.
 *  - Limits (Baileys is unofficial; every sub is a linked device): 10 live
 *    sessions, 5 QR per start, 1 start per 60 s and 10 per rolling day per
 *    sub. Breaching one throws PoolLimitError → HTTP 429 + Retry-After.
 *    The counters are in memory (replicas: 1, strategy Recreate): a pod
 *    restart resets them, which the design accepts.
 *  - QR stays in memory (the factory builds clients with quietQr) and no
 *    message is ingested (ingest: false) in v1.
 */
import { promises as fsp } from 'fs';
import { join } from 'path';
import QRCode from 'qrcode';
import { CREDENTIAL_SESSION_KEY_RE, CredentialStore } from '@mcp-socialmedia/shared';
import {
  CredentialSessionClient,
  CredentialWriteBack,
  attachCredentialSession,
  sessionPathForSub,
} from '../credential-session';

export type PairingState = 'starting' | 'qr' | 'paired' | 'expired' | 'unpaired';

/** The slice of BaileysClient the pool drives (a fake in the specs). */
export interface PairingClient extends CredentialSessionClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(event: 'qr', listener: (qr: string) => void): unknown;
  on(event: 'connected', listener: () => void): unknown;
}

/** Builds the client for one sub; `sessionPath` is already per-sub. */
export type PairingClientFactory = (sessionPath: string, sessionKey: string) => PairingClient;

export interface SessionPoolLimits {
  maxSessions: number;
  maxQrPerStart: number;
  startIntervalMs: number;
  maxStartsPerDay: number;
  idleMs: number;
  qrTtlMs: number;
}

export const DEFAULT_POOL_LIMITS: SessionPoolLimits = {
  maxSessions: 10,
  maxQrPerStart: 5,
  startIntervalMs: 60_000,
  maxStartsPerDay: 10,
  idleMs: 10 * 60_000,
  // Baileys rotates the pairing ref about every 20 s after the first one.
  qrTtlMs: 20_000,
};

const DAY_MS = 24 * 60 * 60_000;

export type PoolLimitReason = 'start_interval' | 'daily_starts' | 'pool_full' | 'qr_limit';

export class PoolLimitError extends Error {
  constructor(
    readonly reason: PoolLimitReason,
    readonly retryAfterSeconds: number
  ) {
    super(`pairing limit reached: ${reason} (retry after ${retryAfterSeconds}s)`);
    this.name = 'PoolLimitError';
  }
}

export class InvalidSessionKeyError extends Error {
  constructor() {
    super('sessionKey must be a Keycloak sub (optionally <sub>:<account>)');
    this.name = 'InvalidSessionKeyError';
  }
}

export interface PairingQr {
  /** Raw baileys pairing string (what the QR encodes). */
  value: string;
  /** PNG data URL of the same QR, rendered in memory. */
  dataUrl: string;
  issuedAt: string;
  expiresAt: string;
}

export interface PairingMe {
  /** `creds.me.id` verbatim (e.g. `34600000000:12@s.whatsapp.net`). */
  id: string;
  /** Device-less user JID (`34600000000@s.whatsapp.net`). */
  jid: string;
  /** E.164 when the user part is a phone number, else null. */
  phone: string | null;
  name: string | null;
}

export interface PairingStatus {
  sessionKey: string;
  state: PairingState;
  qr: PairingQr | null;
  me: PairingMe | null;
}

interface LiveSession {
  sessionKey: string;
  client: PairingClient;
  writeBack: CredentialWriteBack;
  authDir: string;
  state: Exclude<PairingState, 'unpaired'>;
  qrCount: number;
  qr: { value: string; issuedAt: number; expiresAt: number; dataUrl?: string } | null;
  lastTouched: number;
  startedAt: number;
}

export interface SessionPoolOptions {
  store: CredentialStore;
  /** SESSION_PATH root; each sub gets `<root>/by-sub/<sessionKey>`. */
  sessionRoot: string;
  createClient: PairingClientFactory;
  limits?: Partial<SessionPoolLimits>;
  now?: () => number;
  log?: (msg: string) => void;
  /** Write-back debounce (specs use 0). */
  debounceMs?: number;
}

export function assertSessionKey(sessionKey: unknown): asserts sessionKey is string {
  if (typeof sessionKey !== 'string' || !CREDENTIAL_SESSION_KEY_RE.test(sessionKey)) {
    throw new InvalidSessionKeyError();
  }
}

/** `creds.me` → the public `me` shape. Null when not paired yet. */
export function pairingMeFromCreds(creds: unknown): PairingMe | null {
  const me = (creds as { me?: { id?: unknown; name?: unknown } } | null)?.me;
  if (!me || typeof me.id !== 'string' || !me.id) return null;
  const [userPart, server = 's.whatsapp.net'] = me.id.split('@');
  const user = userPart.split(':')[0];
  return {
    id: me.id,
    jid: `${user}@${server}`,
    phone: /^\d{6,15}$/.test(user) ? `+${user}` : null,
    name: typeof me.name === 'string' ? me.name : null,
  };
}

function meFromRowPayload(payload: Record<string, unknown>): PairingMe | null {
  const files = (payload as { files?: Record<string, string> }).files;
  const raw = files?.['creds.json'];
  if (typeof raw !== 'string') return null;
  try {
    return pairingMeFromCreds(JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')));
  } catch {
    return null;
  }
}

export class SessionPool {
  private readonly sessions = new Map<string, LiveSession>();
  /** Subs whose session the provider invalidated during this process's life. */
  private readonly expired = new Map<string, number>();
  /** Subs whose last start spent its QR budget → that start's timestamp. */
  private readonly qrExhausted = new Map<string, number>();
  /** Start timestamps per sub, pruned to the rolling day. */
  private readonly starts = new Map<string, number[]>();
  private readonly limits: SessionPoolLimits;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SessionPoolOptions) {
    this.limits = { ...DEFAULT_POOL_LIMITS, ...(opts.limits || {}) };
    this.now = opts.now || Date.now;
    this.log = opts.log || (msg => console.log(msg));
  }

  /** Live sockets right now (for /health and the specs). */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Begin (or restart) pairing for one sub. Every call is a start: it is
   * rate-limited even when a socket is already live, so a client cannot
   * spin QR generation by hammering it. A sub that is already paired and
   * live is returned as-is (no new socket).
   */
  async start(sessionKey: string): Promise<PairingStatus> {
    assertSessionKey(sessionKey);
    const now = this.now();
    this.checkStartRate(sessionKey, now);

    const existing = this.sessions.get(sessionKey);
    if (existing && existing.state === 'paired') {
      this.recordStart(sessionKey, now);
      existing.lastTouched = now;
      return this.statusOf(existing);
    }

    if (!existing && this.sessions.size >= this.limits.maxSessions) {
      await this.evictIdle();
      if (this.sessions.size >= this.limits.maxSessions) {
        throw new PoolLimitError('pool_full', Math.ceil(this.limits.idleMs / 1000));
      }
    }

    this.recordStart(sessionKey, now);
    if (existing) await this.drop(existing, 'restart');
    this.expired.delete(sessionKey);
    this.qrExhausted.delete(sessionKey);

    const sessionPath = sessionPathForSub(this.opts.sessionRoot, sessionKey);
    const client = this.opts.createClient(sessionPath, sessionKey);
    const authDir = client.getAuthDir();
    // The emptyDir may hold a previous socket's files for this sub: the row
    // (or a fresh pairing) is the only source of truth for a new start.
    await fsp.rm(authDir, { recursive: true, force: true });

    const entry: LiveSession = {
      sessionKey,
      client,
      authDir,
      writeBack: undefined as unknown as CredentialWriteBack,
      state: 'starting',
      qrCount: 0,
      qr: null,
      lastTouched: now,
      startedAt: now,
    };

    const { writeBack } = await attachCredentialSession(client, this.opts.store, sessionKey, {
      writeAfterFirstOpen: true,
      debounceMs: this.opts.debounceMs,
      log: this.log,
      onInvalidated: () => this.markExpired(entry),
    });
    entry.writeBack = writeBack;

    client.on('qr', (qr: string) => this.onQr(entry, qr));
    client.on('connected', () => {
      if (entry.state === 'expired') return;
      entry.state = 'paired';
      entry.qr = null;
      this.log(`pairing: ${sessionKey} connection open`);
    });

    this.sessions.set(sessionKey, entry);
    try {
      await client.connect();
    } catch (e) {
      this.sessions.delete(sessionKey);
      await client.disconnect().catch(() => {});
      throw e;
    }
    return this.statusOf(entry);
  }

  /**
   * State + current QR of ONE sub. Never opens a socket. After the start's
   * QR budget is spent it throws PoolLimitError('qr_limit') until a new
   * start is allowed.
   */
  async status(sessionKey: string): Promise<PairingStatus> {
    assertSessionKey(sessionKey);
    const live = this.sessions.get(sessionKey);
    if (live) {
      live.lastTouched = this.now();
      return this.statusOf(live);
    }
    const exhaustedAt = this.qrExhausted.get(sessionKey);
    if (exhaustedAt !== undefined) {
      const wait = Math.ceil((exhaustedAt + this.limits.startIntervalMs - this.now()) / 1000);
      throw new PoolLimitError('qr_limit', Math.max(1, wait));
    }
    if (this.expired.has(sessionKey)) {
      return { sessionKey, state: 'expired', qr: null, me: null };
    }
    const row = await this.opts.store.get(sessionKey, 'whatsapp');
    if (!row) return { sessionKey, state: 'unpaired', qr: null, me: null };
    return { sessionKey, state: 'paired', qr: null, me: meFromRowPayload(row.payload) };
  }

  /** `creds.me` of ONE sub: live auth dir first, else its row. Never opens a socket. */
  async me(sessionKey: string): Promise<PairingMe | null> {
    assertSessionKey(sessionKey);
    const live = this.sessions.get(sessionKey);
    if (live) {
      live.lastTouched = this.now();
      if (live.state === 'expired') return null;
      if (live.state === 'paired') {
        const local = await this.meFromAuthDir(live.authDir);
        if (local) return local;
      }
    }
    if (this.expired.has(sessionKey)) return null;
    const row = await this.opts.store.get(sessionKey, 'whatsapp');
    return row ? meFromRowPayload(row.payload) : null;
  }

  /** Close sockets idle for longer than `idleMs`. Returns how many went. */
  async evictIdle(): Promise<number> {
    const cutoff = this.now() - this.limits.idleMs;
    let evicted = 0;
    for (const entry of [...this.sessions.values()]) {
      if (entry.lastTouched <= cutoff) {
        await this.drop(entry, 'idle');
        evicted += 1;
      }
    }
    const dayAgo = this.now() - DAY_MS;
    for (const [key, at] of this.expired) if (at <= dayAgo) this.expired.delete(key);
    for (const [key, at] of this.qrExhausted) if (at <= dayAgo) this.qrExhausted.delete(key);
    return evicted;
  }

  startEvictionTimer(intervalMs = 60_000): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => {
      void this.evictIdle().catch(e => this.log(`pairing: eviction failed: ${e?.message || e}`));
    }, intervalMs);
    this.evictionTimer.unref?.();
  }

  /** Flush every write-back and close every socket (SIGTERM). */
  async close(): Promise<void> {
    if (this.evictionTimer) clearInterval(this.evictionTimer);
    this.evictionTimer = null;
    for (const entry of [...this.sessions.values()]) await this.drop(entry, 'shutdown');
  }

  // ---------------------------------------------------------------------------

  private checkStartRate(sessionKey: string, now: number): void {
    const history = (this.starts.get(sessionKey) || []).filter(t => t > now - DAY_MS);
    this.starts.set(sessionKey, history);
    const last = history[history.length - 1];
    if (last !== undefined && now - last < this.limits.startIntervalMs) {
      throw new PoolLimitError(
        'start_interval',
        Math.max(1, Math.ceil((last + this.limits.startIntervalMs - now) / 1000))
      );
    }
    if (history.length >= this.limits.maxStartsPerDay) {
      throw new PoolLimitError(
        'daily_starts',
        Math.max(1, Math.ceil((history[0] + DAY_MS - now) / 1000))
      );
    }
  }

  private recordStart(sessionKey: string, now: number): void {
    const history = this.starts.get(sessionKey) || [];
    history.push(now);
    this.starts.set(sessionKey, history);
  }

  private onQr(entry: LiveSession, qr: string): void {
    if (entry.state === 'expired' || entry.state === 'paired') return;
    if (this.sessions.get(entry.sessionKey) !== entry) return; // replaced
    entry.qrCount += 1;
    if (entry.qrCount > this.limits.maxQrPerStart) {
      // QR budget of this start is spent: stop the socket, keep nothing.
      this.log(`pairing: ${entry.sessionKey} exhausted ${this.limits.maxQrPerStart} QR — closing`);
      entry.qr = null;
      this.sessions.delete(entry.sessionKey);
      void entry.client.disconnect().catch(() => {});
      this.qrExhausted.set(entry.sessionKey, entry.startedAt);
      return;
    }
    const issuedAt = this.now();
    entry.state = 'qr';
    entry.qr = { value: qr, issuedAt, expiresAt: issuedAt + this.limits.qrTtlMs };
  }

  private markExpired(entry: LiveSession): void {
    entry.state = 'expired';
    entry.qr = null;
    this.expired.set(entry.sessionKey, this.now());
    this.log(`pairing: ${entry.sessionKey} logged out — row deleted, state expired`);
    // Stop baileys' reconnect loop (it would emit a fresh QR for nobody).
    if (this.sessions.get(entry.sessionKey) === entry) this.sessions.delete(entry.sessionKey);
    void entry.client.disconnect().catch(() => {});
  }

  private async drop(entry: LiveSession, reason: string): Promise<void> {
    if (this.sessions.get(entry.sessionKey) === entry) this.sessions.delete(entry.sessionKey);
    try {
      await entry.writeBack?.flush();
    } catch {
      /* write-back logs its own failures */
    }
    await entry.client.disconnect().catch(() => {});
    this.log(`pairing: ${entry.sessionKey} socket closed (${reason})`);
  }

  private async statusOf(entry: LiveSession): Promise<PairingStatus> {
    let qr: PairingQr | null = null;
    if (entry.state === 'qr' && entry.qr && entry.qr.expiresAt > this.now()) {
      if (!entry.qr.dataUrl) entry.qr.dataUrl = await QRCode.toDataURL(entry.qr.value);
      qr = {
        value: entry.qr.value,
        dataUrl: entry.qr.dataUrl,
        issuedAt: new Date(entry.qr.issuedAt).toISOString(),
        expiresAt: new Date(entry.qr.expiresAt).toISOString(),
      };
    }
    const me = entry.state === 'paired' ? await this.meFromAuthDir(entry.authDir) : null;
    return { sessionKey: entry.sessionKey, state: entry.state, qr, me };
  }

  private async meFromAuthDir(authDir: string): Promise<PairingMe | null> {
    try {
      return pairingMeFromCreds(
        JSON.parse(await fsp.readFile(join(authDir, 'creds.json'), 'utf-8'))
      );
    } catch {
      return null;
    }
  }
}
