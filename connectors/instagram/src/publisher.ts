/**
 * Instagram Event Publisher — Multi-account.
 * NATS subjects include account name: instagram.{account}.{type}.received
 *
 * INFRA-290 (P3 of INFRA-112): events arriving while NATS is unreachable are no
 * longer discarded. They go into a bounded in-memory retainer (entry cap + age
 * window from env) and are republished FIFO on reconnect, deduplicated by event
 * id. Subject and payload format are unchanged.
 */

import { connect, NatsConnection, JSONCodec, ConnectionOptions, Events } from 'nats';
import pino from 'pino';
import type { WebhookEvent } from './webhook';

const jsonCodec = JSONCodec();

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

/** Default retention: the window declared by the CTO for INFRA-112. */
const DEFAULT_RETENTION_MAX_EVENTS = 500;
const DEFAULT_RETENTION_WINDOW_HOURS = 6;

interface RetainedEvent {
  key: string;
  subject: string;
  payload: Uint8Array;
  enqueuedAtMs: number;
}

interface RetentionStats {
  accepted: number;
  published: number;
  republished: number;
  retained: number;
  duplicateSkipped: number;
  overflowDropped: number;
  expiredDropped: number;
  pendingSize: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stableHash(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * FIFO queue with an entry cap and an age window, deduplicated by key.
 * Duplicated from the whatsapp-web publisher on purpose: INFRA-290's file
 * limits forbid a shared helper in `shared/`.
 */
export class BoundedEventRetainer {
  private queue: RetainedEvent[] = [];
  private keys = new Set<string>();
  private counters = {
    accepted: 0,
    published: 0,
    republished: 0,
    retained: 0,
    duplicateSkipped: 0,
    overflowDropped: 0,
    expiredDropped: 0,
  };
  private readonly maxEvents: number;
  private readonly windowMs: number;

  constructor(opts?: { maxEvents?: number; windowHours?: number }) {
    this.maxEvents =
      opts?.maxEvents ?? envInt('NATS_RETENTION_MAX_EVENTS', DEFAULT_RETENTION_MAX_EVENTS);
    this.windowMs =
      (opts?.windowHours ?? envInt('NATS_RETENTION_WINDOW_HOURS', DEFAULT_RETENTION_WINDOW_HOURS)) *
      3_600_000;
  }

  get maxEntries(): number {
    return this.maxEvents;
  }

  get window(): number {
    return this.windowMs;
  }

  enqueue(item: RetainedEvent): boolean {
    if (this.keys.has(item.key)) {
      this.counters.duplicateSkipped += 1;
      return false;
    }
    this.dropExpired(item.enqueuedAtMs);
    this.queue.push(item);
    this.keys.add(item.key);
    this.counters.retained += 1;
    while (this.queue.length > this.maxEvents) {
      const evicted = this.queue.shift();
      if (evicted) {
        this.keys.delete(evicted.key);
        this.counters.overflowDropped += 1;
      }
    }
    return true;
  }

  peek(): RetainedEvent[] {
    return [...this.queue];
  }

  drain(): RetainedEvent[] {
    const items = this.queue;
    this.queue = [];
    this.keys.clear();
    return items;
  }

  requeueFront(items: RetainedEvent[]): void {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (this.keys.has(item.key)) continue;
      this.queue.unshift(item);
      this.keys.add(item.key);
    }
  }

  pendingSize(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
    this.keys.clear();
  }

  countAccepted(n = 1): void {
    this.counters.accepted += n;
  }

  countPublished(n = 1): void {
    this.counters.published += n;
  }

  countRepublished(n = 1): void {
    this.counters.republished += n;
  }

  stats(): RetentionStats {
    return { ...this.counters, pendingSize: this.queue.length };
  }

  /** Test seam: rewrite an entry's age so window expiry can be asserted. */
  ageItem(key: string, ageMs: number): boolean {
    const item = this.queue.find(entry => entry.key === key);
    if (!item) return false;
    item.enqueuedAtMs = Date.now() - ageMs;
    return true;
  }

  private dropExpired(now: number): void {
    if (this.windowMs <= 0) return;
    while (this.queue.length > 0 && now - this.queue[0].enqueuedAtMs > this.windowMs) {
      const expired = this.queue.shift();
      if (expired) {
        this.keys.delete(expired.key);
        this.counters.expiredDropped += 1;
      }
    }
  }
}

export class InstagramEventPublisher {
  private nc: NatsConnection | null = null;
  private connected = false;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private draining = false;
  private reconnectAttempts = 0;
  // Same knobs as the whatsapp-web publisher: exponential backoff with a cap,
  // so a NATS outage is recovered quickly without hammering the server.
  private readonly reconnectBaseMs = parseInt(process.env.NATS_RECONNECT_BASE_MS || '2000', 10);
  private readonly reconnectMaxMs = parseInt(process.env.NATS_RECONNECT_MAX_MS || '30000', 10);
  private readonly retainer = new BoundedEventRetainer();

  constructor(
    private natsUrl: string,
    private natsCaCert?: string
  ) {}

  async connect(): Promise<void> {
    if (this.connected || this.connecting || this.shuttingDown) {
      return;
    }
    this.connecting = true;
    try {
      const options: ConnectionOptions = {
        servers: this.natsUrl,
        maxReconnectAttempts: -1,
        reconnectTimeWait: this.reconnectBaseMs,
        timeout: 2000,
      };
      if (this.natsUrl.startsWith('tls://') && this.natsCaCert && this.natsCaCert !== 'none') {
        const fs = await import('fs');
        const ca = fs.readFileSync(this.natsCaCert, 'utf-8');
        options.tls = { ca };
      }
      this.nc = await connect(options);
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info('Connected to NATS');
      this.nc
        .closed()
        .then(error => {
          this.connected = false;
          this.nc = null;
          if (this.shuttingDown) return;
          if (error) {
            logger.warn(`NATS connection closed: ${String(error)}`);
          } else {
            logger.warn('NATS connection closed');
          }
          this.scheduleReconnect();
        })
        .catch(error => {
          this.connected = false;
          this.nc = null;
          if (!this.shuttingDown) {
            logger.warn(`NATS connection close watcher failed: ${String(error)}`);
            this.scheduleReconnect();
          }
        });
      void this.watchStatus(this.nc);
      void this.drainRetention();
    } catch (error) {
      logger.warn(`NATS unavailable, retaining events until it returns: ${String(error)}`);
      this.connected = false;
      // Clear the in-flight guard BEFORE scheduling, exactly as the
      // whatsapp-web publisher does: scheduleReconnect() no-ops while
      // `connecting` is true, so scheduling from the catch with the guard set
      // silently cancelled the retry (prod incident 2026-07-02, covered by
      // connectors/whatsapp-web/src/events/publisher.test.ts).
      this.connecting = false;
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Counters for the published-vs-received evidence (INFRA-290 criteria B/C). */
  retentionStats(): RetentionStats {
    return this.retainer.stats();
  }

  pendingRetention(): number {
    return this.retainer.pendingSize();
  }

  /**
   * NATS subject for one event. Overridable so a test harness can drive the
   * real retention path against production NATS under a private subject
   * prefix; production always lands on the subjects consumers already read.
   */
  protected subjectFor(account: string, event: WebhookEvent): string {
    return `instagram.${account}.${event.type}.received`;
  }

  publish(account: string, event: WebhookEvent): void {
    this.retainer.countAccepted();
    const subject = this.subjectFor(account, event);
    const payload = jsonCodec.encode({
      platform: 'instagram',
      account,
      eventType: event.type,
      senderId: event.senderId,
      senderUsername: event.senderUsername,
      conversationId: event.conversationId,
      messageId: event.messageId,
      text: event.text,
      mediaId: event.mediaId,
      timestamp: event.timestamp,
    });
    const key = `ig:${account}:${event.type}:${event.messageId ?? stableHash({ s: event.senderId, c: event.conversationId, t: event.timestamp, x: event.text })}`;

    if (this.nc && this.connected) {
      try {
        this.nc.publish(subject, payload);
        this.retainer.countPublished();
        logger.debug({ subject, account }, 'Event published to NATS');
        return;
      } catch (error) {
        logger.error(`Failed to publish to NATS, retaining event: ${String(error)}`);
        this.markDisconnected();
      }
    }

    const held = this.retainer.enqueue({ key, subject, payload, enqueuedAtMs: Date.now() });
    if (held && this.retainer.pendingSize() === 1) {
      logger.warn(
        { pending: this.retainer.pendingSize() },
        'NATS not connected, event retained for republication'
      );
    }
    // A webhook arriving while NATS is down is also the cheapest signal that a
    // reconnect is needed — keep the old behaviour of nudging the loop.
    this.scheduleReconnect();
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // A deliberate shutdown must not republish.
    this.retainer.clear();
    if (this.nc) {
      await this.nc.close();
      this.nc = null;
      logger.info('Disconnected from NATS');
    }
  }

  /**
   * `flush()` on the nats client has no timeout parameter, and a dead
   * transport can leave it pending — bound it so a drain can always give up
   * and requeue instead of hanging the publisher.
   */
  private flushConfirmed(nc: NatsConnection, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`NATS flush timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      nc.flush().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  private markDisconnected(): void {
    // Keep the client object when it still exists: with
    // maxReconnectAttempts: -1 it is retrying by itself and `watchStatus`
    // flips `connected` back on RECONNECT. Nulling it here would leak that
    // client and open a second connection on top of it.
    this.connected = false;
    if (!this.nc) this.scheduleReconnect();
  }

  /**
   * The client's internal reconnect loop. Without this watcher a *brief*
   * outage is invisible: the client buffers outbound writes and `connected`
   * stays true, so events keep going to a dead socket and the retainer never
   * engages (observed live 2026-09-28 during INFRA-290's fault injection).
   * Disconnect marks the transport dead — new events then land in the
   * retainer; Reconnect means the same client is usable again, so drain.
   */
  private async watchStatus(nc: NatsConnection): Promise<void> {
    try {
      for await (const evt of nc.status()) {
        if (this.nc !== nc) return;
        if (evt.type === Events.Disconnect) {
          this.connected = false;
          logger.warn('NATS transport disconnected, retaining events until it returns');
        } else if (evt.type === Events.Reconnect) {
          this.connected = true;
          this.reconnectAttempts = 0;
          logger.info('NATS reconnected');
          void this.drainRetention();
        }
      }
    } catch {
      /* closed() handles the terminal case and the reconnect schedule */
    }
  }

  private async drainRetention(): Promise<void> {
    if (this.draining || this.shuttingDown || this.retainer.pendingSize() === 0) return;
    this.draining = true;
    let republished = 0;
    try {
      while (this.connected && this.retainer.pendingSize() > 0) {
        const batch = this.retainer.drain();
        if (batch.length === 0) break;
        // Count after the flush confirms the server took the batch, so a
        // interrupted drain can never publish (or count) the same id twice.
        try {
          for (const item of batch) {
            if (!this.nc || !this.connected) throw new Error('NATS connection went away');
            this.nc.publish(item.subject, item.payload);
          }
          if (!this.nc || !this.connected) throw new Error('NATS connection went away');
          await this.flushConfirmed(this.nc, 2000);
        } catch (error) {
          this.retainer.requeueFront(batch);
          logger.warn(`Retention drain failed, ${batch.length} events requeued: ${String(error)}`);
          this.markDisconnected();
          return;
        }
        republished += batch.length;
        this.retainer.countRepublished(batch.length);
      }
      if (republished > 0) {
        logger.info(
          { republished, pending: this.retainer.pendingSize() },
          'Retained events republished'
        );
      }
    } finally {
      this.draining = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.connected || this.connecting || this.shuttingDown) {
      return;
    }
    // The client owns its own reconnect loop (maxReconnectAttempts: -1): while
    // `nc` still exists it is retrying by itself and watchStatus() flips
    // `connected` back on Reconnect. Starting a second connection here would
    // leak the first one.
    if (this.nc) return;
    const delayMs = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * Math.max(1, 2 ** this.reconnectAttempts)
    );
    this.reconnectAttempts += 1;
    logger.warn(`Scheduling NATS reconnect in ${delayMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
    // Don't hold the process open just for a reconnect timer.
    (this.reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }
}
