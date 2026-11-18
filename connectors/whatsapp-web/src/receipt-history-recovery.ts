import { proto, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys';

export type ReceiptRecoveryState = 'pending' | 'complete' | 'unsupported' | 'timeout' | 'failed';
export interface ReceiptRecoveryStatus {
  state: ReceiptRecoveryState;
  retryAfterMs?: number;
}
export interface ReceiptRecoveryTarget {
  account: string;
  chatId: string;
  messageId: string;
  aliases: string[];
}
export interface ReceiptRecoveryAnchor {
  key: WAMessageKey;
  timestampMs: number;
}
type HistoryUpdate = {
  syncType?: number | null;
  peerDataRequestSessionId?: string | null;
  messages: WAMessage[];
};
interface Attempt {
  target: ReceiptRecoveryTarget;
  state: ReceiptRecoveryState;
  requestedAt: number;
  sessionId?: string;
  timer: ReturnType<typeof setTimeout>;
  deadlineTimer: ReturnType<typeof setTimeout>;
  end: Promise<void>;
  resolveEnd: () => void;
  sessionReady: Promise<void>;
  resolveSession: () => void;
  sessionSettled: boolean;
  persisting: boolean;
}
const normalized = (jid: string) => jid.replace(/@s\.whatsapp\.net$/, '@c.us');

/** A phone history request is best effort, never a promise that receipts exist. */
export class ReceiptHistoryRecovery {
  private attempts = new Map<string, Attempt>();
  constructor(
    private readonly options: {
      anchor: (target: ReceiptRecoveryTarget) => Promise<ReceiptRecoveryAnchor | null>;
      fetch: (count: number, key: WAMessageKey, timestampMs: number) => Promise<string>;
      persist: (target: ReceiptRecoveryTarget, message: WAMessage) => Promise<void>;
      timeoutMs?: number;
      cooldownMs?: number;
      maxEntries?: number;
      maxPending?: number;
    }
  ) {}
  private key(target: ReceiptRecoveryTarget) {
    return JSON.stringify([target.account, target.chatId, target.messageId]);
  }
  private status(attempt: Attempt): ReceiptRecoveryStatus {
    return {
      state: attempt.state,
      ...(attempt.state === 'pending' ? { retryAfterMs: 5_000 } : {}),
    };
  }
  current(target: ReceiptRecoveryTarget): ReceiptRecoveryStatus | undefined {
    const attempt = this.attempts.get(this.key(target));
    return attempt ? this.status(attempt) : undefined;
  }
  request(target: ReceiptRecoveryTarget): ReceiptRecoveryStatus {
    const key = this.key(target);
    const existing = this.attempts.get(key);
    if (
      existing &&
      (existing.state === 'pending' ||
        existing.requestedAt + (this.options.cooldownMs ?? 60_000) > Date.now())
    )
      return this.status(existing);
    const maxEntries = this.options.maxEntries ?? 256;
    for (const [id, attempt] of this.attempts) {
      if (this.attempts.size < maxEntries) break;
      if (
        attempt.state !== 'pending' &&
        attempt.sessionSettled &&
        attempt.requestedAt + (this.options.cooldownMs ?? 60_000) <= Date.now()
      )
        this.attempts.delete(id);
    }
    if (
      this.attempts.size >= maxEntries ||
      [...this.attempts.values()].filter(a => a.state === 'pending' || !a.sessionSettled).length >=
        (this.options.maxPending ?? 4)
    )
      return { state: 'unsupported' };
    let resolveSession!: () => void;
    const sessionReady = new Promise<void>(resolve => (resolveSession = resolve));
    let resolveEnd!: () => void;
    const end = new Promise<void>(resolve => (resolveEnd = resolve));
    const attempt: Attempt = {
      target,
      state: 'pending',
      requestedAt: Date.now(),
      timer: setTimeout(() => this.finish(attempt, 'timeout'), this.options.timeoutMs ?? 15_000),
      deadlineTimer: setTimeout(() => {
        this.finish(attempt, 'timeout');
        attempt.sessionSettled = true;
        attempt.resolveEnd();
        attempt.resolveSession();
      }, this.options.cooldownMs ?? 60_000),
      end,
      resolveEnd,
      sessionReady,
      resolveSession,
      sessionSettled: false,
      persisting: false,
    };
    attempt.timer.unref?.();
    attempt.deadlineTimer.unref?.();
    this.attempts.set(key, attempt);
    void this.start(attempt)
      .catch(() => this.finish(attempt, 'failed'))
      .finally(() => {
        attempt.sessionSettled = true;
        attempt.resolveSession();
      });
    return this.status(attempt);
  }
  private finish(attempt: Attempt, state: ReceiptRecoveryState) {
    if (attempt.state !== 'pending') return;
    attempt.state = state;
    clearTimeout(attempt.timer);
  }
  private async start(attempt: Attempt): Promise<void> {
    const anchor = await Promise.race([
      this.options.anchor(attempt.target),
      attempt.end.then(() => null),
    ]);
    if (attempt.state !== 'pending') return;
    if (!anchor) {
      this.finish(attempt, 'unsupported');
      return;
    }
    // rc13 serializes this value as oldestMsgTimestampMs, not seconds.
    const sessionId = await Promise.race([
      this.options.fetch(10, anchor.key, anchor.timestampMs),
      attempt.end.then(() => null),
    ]);
    if (attempt.sessionSettled) return;
    if (!sessionId) {
      this.finish(attempt, 'unsupported');
      return;
    }
    attempt.sessionId = sessionId;
  }
  private matches(attempt: Attempt, message: WAMessage) {
    return (
      message.key?.id === attempt.target.messageId &&
      message.key?.fromMe === true &&
      !!message.key.remoteJid &&
      attempt.target.aliases.some(jid => normalized(jid) === normalized(message.key.remoteJid!))
    );
  }
  /** true claims only our on-demand reply; its unrelated messages must never enter full ingest. */
  async consume(update: HistoryUpdate): Promise<boolean> {
    if (
      update.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND ||
      !update.peerDataRequestSessionId
    )
      return false;
    const session = update.peerDataRequestSessionId;
    // Baileys returns the request ID only after relayMessage resolves. Keep the
    // event handler suspended until correlation is possible; unrelated sessions
    // then continue through normal history handling instead of being discarded.
    while (![...this.attempts.values()].some(attempt => attempt.sessionId === session)) {
      const unknown = [...this.attempts.values()].filter(
        attempt =>
          !attempt.sessionId &&
          !attempt.sessionSettled &&
          ['pending', 'timeout'].includes(attempt.state) &&
          attempt.requestedAt + (this.options.cooldownMs ?? 60_000) > Date.now()
      );
      if (!unknown.length) break;
      const remaining = Math.min(
        ...unknown.map(a => a.requestedAt + (this.options.cooldownMs ?? 60_000) - Date.now())
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ...unknown.map(attempt => attempt.sessionReady),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, remaining);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    let claimed = false;
    for (const attempt of this.attempts.values()) {
      const matching = update.messages.find(message => this.matches(attempt, message));
      if (attempt.sessionId !== session) continue;
      claimed = true;
      if (
        !['pending', 'timeout', 'complete'].includes(attempt.state) ||
        attempt.persisting ||
        !matching ||
        attempt.requestedAt + (this.options.cooldownMs ?? 60_000) <= Date.now()
      )
        continue;
      attempt.persisting = true;
      try {
        await this.options.persist(attempt.target, matching);
        if (attempt.state === 'timeout') attempt.state = 'complete';
        else this.finish(attempt, 'complete');
      } catch {
        this.finish(attempt, 'failed');
      } finally {
        attempt.persisting = false;
      }
    }
    return claimed;
  }
  stop(): void {
    for (const attempt of this.attempts.values()) {
      if (attempt.state === 'pending' || attempt.state === 'timeout') {
        attempt.state = 'failed';
        clearTimeout(attempt.timer);
      }
      attempt.resolveSession();
      attempt.sessionSettled = true;
      clearTimeout(attempt.deadlineTimer);
      attempt.resolveEnd();
    }
  }
}
