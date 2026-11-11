/**
 * SC-1229 (SC-1197 P4b): the per-sub mtcute pairing pool behind the
 * `telegram-pairing` Deployment — the Telegram twin of
 * connectors/whatsapp-web/src/pairing/session-pool.ts (design D1 "por
 * analogía", D7).
 *
 * One mtcute client per `sessionKey` (= the caller's Keycloak `sub`, fixed
 * by social-api from the verified JWT — this process never sees a JWT, it
 * trusts the HMAC-signed body). Properties the design pins:
 *
 *  - Persistence is ONLY the credential store (`user_channel_credentials`,
 *    channel `telegram`), through the existing mtcute adapter
 *    (shared/session-store/adapters/mtcute-session.ts). mtcute state lives
 *    in memory (MemoryStorage); nothing is written to disk, so SESSION_PATH
 *    is not used here.
 *  - Login is the QR flow (`signInQr`, present in the pinned @mtcute 0.29.7)
 *    with the same polling shape as WhatsApp: state + QR + caducidad. QR
 *    rotation carries Telegram's own expiry (onUrlUpdated gives it).
 *  - 2FA: when the flow hits SESSION_PASSWORD_NEEDED the pool moves to the
 *    extra `password` state and waits for submitPassword(); a rejected
 *    password goes back to `password` (mtcute re-invokes the callback), so
 *    the user can retry without restarting the flow.
 *  - The row is written only after the authorization completes (the analogue
 *    of the baileys "row after first connection: open"): an unscanned QR
 *    leaves no trace. A session the server rejects later (revoked from the
 *    app) deletes its row and marks the sub `expired` — same choreography
 *    as the house connector's session-invalidated hook (SC-1145).
 *  - Lazy: nothing connects at boot. `status` of a sub with no live socket
 *    reads the row and never opens one; `me` may open ONE short-lived
 *    connection to answer from the row without re-authorization (the
 *    "pool nuevo → /me/telegram sale de la fila" criterion) and caches the
 *    identity for the life of the process.
 *  - Limits identical to WhatsApp (10 sessions, 5 QR per start, 1 start per
 *    60 s and 10 per rolling day per sub) → PoolLimitError → 429 +
 *    Retry-After. Counters are in memory (replicas: 1, Recreate).
 *  - The house env sessions (TELEGRAM_SESSION_STRING*) are NEVER read here:
 *    this pool only ever speaks to the store row of the sub it is pairing
 *    (main.ts reads no such variable; app.test.ts pins it).
 */
import QRCode from 'qrcode';
import {
  CREDENTIAL_SESSION_KEY_RE,
  CredentialStore,
  deserializeMtcuteSession,
  serializeMtcuteSession,
} from '@mcp-socialmedia/shared';
import { isSessionInvalidatedError } from '../credential-session';

export type TelegramPairingState =
  'starting' | 'qr' | 'password' | 'paired' | 'expired' | 'unpaired';

/** The caller-facing identity of a paired Telegram account. */
export interface TelegramPairingMe {
  /** Telegram user id, decimal string. */
  id: string;
  /** @username without the @, null when the account has none. */
  username: string | null;
}

/** Callbacks the pool hands the client for one pairing flow. */
export interface TelegramAuthHandlers {
  /** Telegram rotated the login URL: display this (renders to the QR). */
  onQr(url: string, expiresAt: Date): void;
  /** The user scanned; the library is finalizing the auth. */
  onQrScanned(): void;
  /** 2FA requested: resolve with the password the user submits. */
  password(): Promise<string>;
  /** The server rejected the password: the next password() call retries. */
  onPasswordInvalid(): void;
  /** Aborted when the QR budget of this start is spent or on shutdown. */
  signal: AbortSignal;
}

/**
 * The slice of the mtcute client the pool drives (a fake in the specs).
 * The real implementation is ./client.ts.
 */
export interface PairingTelegramClient {
  /** QR login flow; resolves with the authorized user when it completes. */
  startPairing(handlers: TelegramAuthHandlers): Promise<TelegramPairingMe>;
  /** Connect with a stored session string and read the identity. Throws on a dead session. */
  loadSession(sessionString: string): Promise<TelegramPairingMe>;
  /** Current session string, for the store row. */
  exportSessionString(): Promise<string>;
  disconnect(): Promise<void>;
}

/** Builds the client for one sub. */
export type PairingTelegramClientFactory = (sessionKey: string) => PairingTelegramClient;

export interface TelegramPoolLimits {
  maxSessions: number;
  maxQrPerStart: number;
  startIntervalMs: number;
  maxStartsPerDay: number;
  idleMs: number;
}

export const DEFAULT_TELEGRAM_POOL_LIMITS: TelegramPoolLimits = {
  maxSessions: 10,
  maxQrPerStart: 5,
  startIntervalMs: 60_000,
  maxStartsPerDay: 10,
  idleMs: 10 * 60_000,
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

/** /password arrived while the flow is not waiting for one. */
export class NotAwaitingPasswordError extends Error {
  constructor() {
    super('this pairing is not waiting for a password');
    this.name = 'NotAwaitingPasswordError';
  }
}

/** /password arrived without a usable password string. */
export class InvalidPasswordError extends Error {
  constructor() {
    super('password must be a non-empty string');
    this.name = 'InvalidPasswordError';
  }
}

export interface TelegramPairingQr {
  /** Raw tg://confirm... login URL the QR encodes. */
  value: string;
  /** PNG data URL of the same QR, rendered in memory. */
  dataUrl: string;
  issuedAt: string;
  expiresAt: string;
}

export interface TelegramPairingStatus {
  sessionKey: string;
  state: TelegramPairingState;
  qr: TelegramPairingQr | null;
  me: TelegramPairingMe | null;
}

interface PasswordWaiter {
  resolve: (password: string) => void;
  reject: (err: Error) => void;
}

interface LivePairing {
  sessionKey: string;
  client: PairingTelegramClient;
  state: Exclude<TelegramPairingState, 'unpaired'>;
  qrCount: number;
  qr: { value: string; issuedAt: number; expiresAt: number; dataUrl?: string } | null;
  me: TelegramPairingMe | null;
  passwordWaiter: PasswordWaiter | null;
  abort: AbortController;
  lastTouched: number;
  startedAt: number;
}

export interface TelegramSessionPoolOptions {
  store: CredentialStore;
  createClient: PairingTelegramClientFactory;
  limits?: Partial<TelegramPoolLimits>;
  now?: () => number;
  log?: (msg: string) => void;
}

export function assertSessionKey(sessionKey: unknown): asserts sessionKey is string {
  if (typeof sessionKey !== 'string' || !CREDENTIAL_SESSION_KEY_RE.test(sessionKey)) {
    throw new InvalidSessionKeyError();
  }
}

export class TelegramSessionPool {
  private readonly sessions = new Map<string, LivePairing>();
  /** Subs whose session the provider invalidated during this process's life. */
  private readonly expired = new Map<string, number>();
  /** Subs whose last start spent its QR budget → that start's timestamp. */
  private readonly qrExhausted = new Map<string, number>();
  /** Start timestamps per sub, pruned to the rolling day. */
  private readonly starts = new Map<string, number[]>();
  /** Identity per sub, learned at pairing or at the first lazy `me` after a restart. */
  private readonly identities = new Map<string, TelegramPairingMe>();
  private readonly limits: TelegramPoolLimits;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: TelegramSessionPoolOptions) {
    this.limits = { ...DEFAULT_TELEGRAM_POOL_LIMITS, ...(opts.limits || {}) };
    this.now = opts.now || Date.now;
    this.log = opts.log || (msg => console.log(msg));
  }

  /** Live sockets right now (for /health and the specs). */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Begin (or restart) pairing for one sub. Every call is a start: it is
   * rate-limited even when a socket is already live. A sub that is already
   * paired and live is returned as-is (no new socket).
   */
  async start(sessionKey: string): Promise<TelegramPairingStatus> {
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

    const entry: LivePairing = {
      sessionKey,
      client: this.opts.createClient(sessionKey),
      state: 'starting',
      qrCount: 0,
      qr: null,
      me: null,
      passwordWaiter: null,
      abort: new AbortController(),
      lastTouched: now,
      startedAt: now,
    };
    this.sessions.set(sessionKey, entry);
    // The flow runs in the background: /start answers `starting` and the
    // polling route (GET /pairing/telegram) follows it to qr → password? →
    // paired, exactly like the baileys pool follows connect → qr → open.
    void this.runFlow(entry);
    return this.statusOf(entry);
  }

  /**
   * State + current QR of ONE sub. Never opens a socket. After the start's
   * QR budget is spent it throws PoolLimitError('qr_limit') until a new
   * start is allowed. A row without a live socket is `paired` (the row is
   * only ever written after a completed authorization); `me` may be null
   * until something reads it (see me()).
   *
   * READING does not extend the session's idle life (SC-1229 round 2, same
   * criterion as C1 of SC-1243): the `password` state waits for the user
   * without a bound, so a client that polls /state in a loop could otherwise
   * park a session forever and hold one of the 10 slots. Only start,
   * submitPassword and me renew lastTouched; evictIdle closes a flow nobody
   * has acted on for idleMs.
   */
  async status(sessionKey: string): Promise<TelegramPairingStatus> {
    assertSessionKey(sessionKey);
    const live = this.sessions.get(sessionKey);
    if (live) {
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
    const row = await this.opts.store.get(sessionKey, 'telegram');
    if (!row) return { sessionKey, state: 'unpaired', qr: null, me: null };
    return {
      sessionKey,
      state: 'paired',
      qr: null,
      me: this.identities.get(sessionKey) ?? null,
    };
  }

  /**
   * Identity of ONE sub: live socket first, else the row — read through ONE
   * short-lived connection when this process has not seen the identity yet
   * (lazy load after a restart: the session string in the row authorizes
   * that connection, the user never re-scans). Never opens a socket for a
   * sub without a row.
   */
  async me(sessionKey: string): Promise<TelegramPairingMe | null> {
    assertSessionKey(sessionKey);
    const live = this.sessions.get(sessionKey);
    if (live) {
      live.lastTouched = this.now();
      if (live.state === 'paired' && live.me) return live.me;
      if (live.state === 'expired') return null;
    }
    if (this.expired.has(sessionKey)) return null;
    const cached = this.identities.get(sessionKey);
    if (cached) return cached;
    const row = await this.opts.store.get(sessionKey, 'telegram');
    if (!row) return null;
    return this.lazyLoadIdentity(sessionKey, row.payload);
  }

  /**
   * Hand the 2FA password to a flow waiting in the `password` state. A
   * rejected password returns the flow to `password` (mtcute re-invokes the
   * callback), so this can be called again.
   */
  async submitPassword(sessionKey: string, password: string): Promise<TelegramPairingStatus> {
    assertSessionKey(sessionKey);
    if (typeof password !== 'string' || password === '') {
      // the app validates before calling; belt and braces for direct users
      throw new InvalidPasswordError();
    }
    const live = this.sessions.get(sessionKey);
    if (!live || live.state !== 'password' || !live.passwordWaiter) {
      throw new NotAwaitingPasswordError();
    }
    live.lastTouched = this.now();
    const waiter = live.passwordWaiter;
    live.passwordWaiter = null;
    waiter.resolve(password);
    return this.statusOf(live);
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
      void this.evictIdle().catch(e =>
        this.log(`telegram-pairing: eviction failed: ${e?.message || e}`)
      );
    }, intervalMs);
    this.evictionTimer.unref?.();
  }

  /** Abort every flow and close every socket (SIGTERM). */
  async close(): Promise<void> {
    if (this.evictionTimer) clearInterval(this.evictionTimer);
    this.evictionTimer = null;
    for (const entry of [...this.sessions.values()]) await this.drop(entry, 'shutdown');
  }

  // ---------------------------------------------------------------------------

  /** The background QR flow of one start. */
  private async runFlow(entry: LivePairing): Promise<void> {
    const { sessionKey } = entry;
    try {
      const me = await entry.client.startPairing({
        onQr: (url, expiresAt) => this.onQr(entry, url, expiresAt),
        onQrScanned: () => this.log(`telegram-pairing: ${sessionKey} QR scanned`),
        password: () => this.requestPassword(entry),
        onPasswordInvalid: () => {
          this.log(`telegram-pairing: ${sessionKey} password rejected — asking again`);
          if (this.isCurrent(entry)) entry.state = 'password';
        },
        signal: entry.abort.signal,
      });
      // Authorization completed: the credential is real even if this socket
      // was superseded or evicted while the last round-trip was in flight —
      // the row is written either way (the analogue of baileys' first
      // connection: open), and the live entry only updates if it still owns
      // the slot.
      this.identities.set(sessionKey, me);
      if (this.isCurrent(entry)) {
        entry.state = 'paired';
        entry.qr = null;
        entry.me = me;
      }
      const sessionString = await entry.client.exportSessionString();
      await this.opts.store.put(sessionKey, 'telegram', {
        ...serializeMtcuteSession(sessionString),
      });
      this.log(`telegram-pairing: ${sessionKey} authorized — row written`);
    } catch (e) {
      if (entry.abort.signal.aborted) {
        // QR budget spent or shutdown: onQr/drop already cleaned up.
        return;
      }
      if (isSessionInvalidatedError(e)) {
        await this.markExpired(entry, e);
        return;
      }
      this.log(`telegram-pairing: ${sessionKey} pairing failed: ${(e as Error)?.message || e}`);
      await this.drop(entry, 'auth-failed');
    }
  }

  /**
   * The 2FA callback: park the flow in `password` and resolve when
   * submitPassword() arrives. A pending waiter is rejected if the flow dies
   * (restart/shutdown), so the library never hangs on a dead socket.
   */
  private requestPassword(entry: LivePairing): Promise<string> {
    if (!this.isCurrent(entry)) return Promise.reject(new Error('pairing closed'));
    entry.state = 'password';
    entry.qr = null;
    this.log(`telegram-pairing: ${entry.sessionKey} 2FA requested`);
    return new Promise<string>((resolve, reject) => {
      entry.passwordWaiter = { resolve, reject };
    });
  }

  private onQr(entry: LivePairing, url: string, expiresAt: Date): void {
    if (entry.state === 'expired' || entry.state === 'paired') return;
    if (!this.isCurrent(entry)) return; // replaced
    entry.qrCount += 1;
    if (entry.qrCount > this.limits.maxQrPerStart) {
      // QR budget of this start is spent: stop the flow, keep nothing.
      this.log(
        `telegram-pairing: ${entry.sessionKey} exhausted ${this.limits.maxQrPerStart} QR — closing`
      );
      entry.qr = null;
      this.sessions.delete(entry.sessionKey);
      entry.abort.abort();
      entry.passwordWaiter?.reject(new Error('qr budget spent'));
      entry.passwordWaiter = null;
      void entry.client.disconnect().catch(() => {});
      this.qrExhausted.set(entry.sessionKey, entry.startedAt);
      return;
    }
    const issuedAt = this.now();
    const expiry =
      expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())
        ? expiresAt.getTime()
        : issuedAt + 30_000;
    entry.state = 'qr';
    entry.qr = { value: url, issuedAt, expiresAt: Math.max(expiry, issuedAt + 1000) };
  }

  /** Telegram invalidated the session (revoked from the app): row gone, expired. */
  private async markExpired(entry: LivePairing, e: unknown): Promise<void> {
    entry.state = 'expired';
    entry.qr = null;
    this.expired.set(entry.sessionKey, this.now());
    this.identities.delete(entry.sessionKey);
    this.log(
      `telegram-pairing: ${entry.sessionKey} session invalidated (${(e as Error)?.message || e}) — row deleted`
    );
    await this.opts.store.delete(entry.sessionKey, 'telegram').catch(err => {
      this.log(`telegram-pairing: ${entry.sessionKey} row delete failed: ${err?.message || err}`);
    });
    await this.drop(entry, 'expired');
  }

  private async markExpiredSub(sessionKey: string): Promise<void> {
    this.expired.set(sessionKey, this.now());
    this.identities.delete(sessionKey);
    const live = this.sessions.get(sessionKey);
    if (live) await this.drop(live, 'expired');
  }

  /**
   * One short-lived connection to answer `me` from the row after a restart.
   * A dead session deletes its row (SC-1145 choreography); a refreshed
   * export keeps the row current (auth-key rotation), best-effort.
   */
  private async lazyLoadIdentity(
    sessionKey: string,
    payload: Record<string, unknown>
  ): Promise<TelegramPairingMe | null> {
    const sessionString = deserializeMtcuteSession(payload).sessionString;
    const client = this.opts.createClient(sessionKey);
    try {
      const me = await client.loadSession(sessionString);
      this.identities.set(sessionKey, me);
      try {
        const refreshed = await client.exportSessionString();
        await this.opts.store.put(sessionKey, 'telegram', {
          ...serializeMtcuteSession(refreshed),
        });
      } catch (e) {
        this.log(
          `telegram-pairing: ${sessionKey} lazy-load write-back failed: ${(e as Error)?.message || e}`
        );
      }
      return me;
    } catch (e) {
      if (isSessionInvalidatedError(e)) {
        this.log(`telegram-pairing: ${sessionKey} stored session is dead — row deleted`);
        await this.opts.store.delete(sessionKey, 'telegram').catch(() => {});
        await this.markExpiredSub(sessionKey);
        return null;
      }
      throw e;
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  private isCurrent(entry: LivePairing): boolean {
    return this.sessions.get(entry.sessionKey) === entry;
  }

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

  private async drop(entry: LivePairing, reason: string): Promise<void> {
    if (this.isCurrent(entry)) this.sessions.delete(entry.sessionKey);
    entry.abort.abort();
    entry.passwordWaiter?.reject(new Error(`pairing closed (${reason})`));
    entry.passwordWaiter = null;
    await entry.client.disconnect().catch(() => {});
    this.log(`telegram-pairing: ${entry.sessionKey} socket closed (${reason})`);
  }

  private async statusOf(entry: LivePairing): Promise<TelegramPairingStatus> {
    let qr: TelegramPairingQr | null = null;
    if (entry.state === 'qr' && entry.qr && entry.qr.expiresAt > this.now()) {
      if (!entry.qr.dataUrl) entry.qr.dataUrl = await QRCode.toDataURL(entry.qr.value);
      qr = {
        value: entry.qr.value,
        dataUrl: entry.qr.dataUrl,
        issuedAt: new Date(entry.qr.issuedAt).toISOString(),
        expiresAt: new Date(entry.qr.expiresAt).toISOString(),
      };
    }
    return {
      sessionKey: entry.sessionKey,
      state: entry.state,
      qr,
      me: entry.state === 'paired' ? entry.me : null,
    };
  }
}
