/**
 * SC-1229 spec helpers: an in-memory credential store (shared shape with the
 * whatsapp pool specs, channel-agnostic) and a fake mtcute client the pool
 * drives exactly like PairingTelegramClientImpl (same handlers, same
 * abort/password choreography).
 */
import type { CredentialChannel, CredentialStore, StoredCredential } from '@mcp-socialmedia/shared';
import type {
  PairingTelegramClient,
  TelegramAuthHandlers,
  TelegramPairingMe,
} from './session-pool';

export class MemoryStore implements CredentialStore {
  rows = new Map<string, StoredCredential>();
  gets = 0;
  puts = 0;
  deletes = 0;
  async get(sessionKey: string, channel: CredentialChannel): Promise<StoredCredential | null> {
    this.gets += 1;
    return this.rows.get(`${sessionKey}/${channel}`) ?? null;
  }
  async put(
    sessionKey: string,
    channel: CredentialChannel,
    payload: Record<string, unknown>
  ): Promise<void> {
    this.puts += 1;
    this.rows.set(`${sessionKey}/${channel}`, {
      sessionKey,
      channel,
      payload: JSON.parse(JSON.stringify(payload)),
      updatedAt: new Date(),
    });
  }
  async delete(sessionKey: string, channel: CredentialChannel): Promise<void> {
    this.deletes += 1;
    this.rows.delete(`${sessionKey}/${channel}`);
  }
  rowsFor(sessionKey: string, channel?: CredentialChannel): number {
    return [...this.rows.values()].filter(
      r => r.sessionKey === sessionKey && (!channel || r.channel === channel)
    ).length;
  }
}

export class FakeTelegramClient implements PairingTelegramClient {
  authFlows = 0;
  /** session strings loadSession was called with (the lazy-load evidence). */
  loadedSessions: string[] = [];
  disconnects = 0;
  exports = 0;
  /** What exportSessionString returns (per-fake, deterministic). */
  exportValue = '1.fake-export';
  /** Error to throw from loadSession (a dead stored session). */
  loadError: Error | null = null;
  loadMe: TelegramPairingMe = { id: '42', username: 'ana' };

  private handlers: TelegramAuthHandlers | null = null;
  private resolveAuth: ((me: TelegramPairingMe) => void) | null = null;
  private rejectAuth: ((e: Error) => void) | null = null;
  /** Resolves with the password the pool's submitPassword handed over. */
  passwordPromise: Promise<string> | null = null;

  constructor(readonly sessionKey: string) {}

  async startPairing(handlers: TelegramAuthHandlers): Promise<TelegramPairingMe> {
    this.authFlows += 1;
    this.handlers = handlers;
    handlers.signal.addEventListener('abort', () => {
      this.rejectAuth?.(new Error('aborted'));
    });
    return new Promise<TelegramPairingMe>((resolve, reject) => {
      this.resolveAuth = resolve;
      this.rejectAuth = reject;
    });
  }

  async loadSession(sessionString: string): Promise<TelegramPairingMe> {
    this.loadedSessions.push(sessionString);
    if (this.loadError) throw this.loadError;
    return this.loadMe;
  }

  async exportSessionString(): Promise<string> {
    this.exports += 1;
    return this.exportValue;
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1;
  }

  // --- simulation of what Telegram does to the flow -------------------------
  emitQr(url = 'tg://confirm/AAAA?hash=bbb', ttlMs = 30_000): void {
    this.handlers?.onQr(url, new Date(Date.now() + ttlMs));
  }
  /** The server answered SESSION_PASSWORD_NEEDED: mtcute calls password(). */
  requestPassword(): Promise<string> {
    this.passwordPromise = this.handlers!.password();
    return this.passwordPromise;
  }
  /** The server rejected the password (PASSWORD_HASH_INVALID). */
  rejectPassword(): void {
    this.handlers?.onPasswordInvalid();
  }
  /** The user scanned: mtcute finalizes; then the flow resolves on authorize(). */
  scanned(): void {
    this.handlers?.onQrScanned();
  }
  authorize(me: TelegramPairingMe = { id: '123456789', username: 'ana_tg' }): void {
    this.resolveAuth?.(me);
  }
  failAuth(e: Error): void {
    this.rejectAuth?.(e);
  }
}

export class FakeTelegramFactory {
  clients: FakeTelegramClient[] = [];
  /**
   * When set, given to every client created as its `loadMe` — a restarted
   * pool reading the row must get the SAME account that paired it.
   */
  loadMe: TelegramPairingMe | null = null;
  create = (sessionKey: string): FakeTelegramClient => {
    const c = new FakeTelegramClient(sessionKey);
    if (this.loadMe) c.loadMe = this.loadMe;
    this.clients.push(c);
    return c;
  };
  last(sessionKey: string): FakeTelegramClient {
    const found = [...this.clients].reverse().find(c => c.sessionKey === sessionKey);
    if (!found) throw new Error(`no client for ${sessionKey}`);
    return found;
  }
  authFlowsFor(sessionKey: string): number {
    return this.clients
      .filter(c => c.sessionKey === sessionKey)
      .reduce((n, c) => n + c.authFlows, 0);
  }
  loadCallsFor(sessionKey: string): number {
    return this.clients
      .filter(c => c.sessionKey === sessionKey)
      .reduce((n, c) => n + c.loadedSessions.length, 0);
  }
}

export class Clock {
  constructor(public t = Date.parse('2026-09-25T10:00:00Z')) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}
