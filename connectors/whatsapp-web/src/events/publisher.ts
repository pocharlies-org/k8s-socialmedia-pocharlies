/**
 * WhatsApp Web → NATS event publisher.
 *
 * INFRA-290 (P3 of INFRA-112): while NATS is unreachable the connector no
 * longer discards events. They go into a bounded in-memory retainer (entry
 * cap + age window, both from env) and are republished in FIFO order once the
 * connection is back, deduplicated by event id. Subjects and payload format are
 * untouched — consumers (mcp-server ingestion, embedding-job, synapse bridge)
 * keep receiving exactly what they did before.
 */
import { connect, NatsConnection, JSONCodec, Codec, ConnectionOptions, Events } from 'nats';
import {
  MessageReceivedEvent,
  MessageUpdatedEvent,
  ChatUpdatedEvent,
  WhatsAppEvent,
  EventType,
} from '@mcp-socialmedia/shared';
import pino from 'pino';
import * as fs from 'fs';

const jsonCodec: Codec<WhatsAppEvent> = JSONCodec();

/** Default retention: the window declared by the CTO for INFRA-112. */
const DEFAULT_RETENTION_MAX_EVENTS = 500;
const DEFAULT_RETENTION_WINDOW_HOURS = 6;

export interface RetainedEvent {
  /** Dedup key — see `retentionKeyFor*` below. Stable per logical event. */
  key: string;
  subject: string;
  payload: Uint8Array;
  enqueuedAtMs: number;
}

export interface RetentionStats {
  /** Logical events handed to the publisher. */
  accepted: number;
  /** Sent on the first attempt, while connected. */
  published: number;
  /** Sent from the retainer after a reconnect. */
  republished: number;
  /** Enqueued into the retainer at least once. */
  retained: number;
  /** Arrived while the same key was already waiting in the retainer. */
  duplicateSkipped: number;
  /** Evicted (oldest first) because the entry cap was reached. */
  overflowDropped: number;
  /** Dropped for being older than the declared window. */
  expiredDropped: number;
  /** Events still waiting in the retainer right now. */
  pendingSize: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Short, stable hash used to key events that carry no natural id. */
function stableHash(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * FIFO queue with an entry cap and an age window, deduplicated by key.
 *
 * Kept inside the connector package on purpose: INFRA-290's file limits forbid
 * a shared helper, so the Instagram publisher carries its own copy.
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

  /**
   * Queue one event. Returns true when it is newly held. A key already waiting
   * is never queued twice — republishing must not duplicate by event id.
   */
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

  /** Items waiting, oldest first. Does not remove them. */
  peek(): RetainedEvent[] {
    return [...this.queue];
  }

  /**
   * Remove and return everything currently held, oldest first. The caller is
   * expected to hand back what it could not send via `requeueFront()` — that is
   * what keeps a half-finished drain from duplicating events.
   */
  drain(): RetainedEvent[] {
    const items = this.queue;
    this.queue = [];
    this.keys.clear();
    return items;
  }

  /** Put items back at the head (order preserved) after a failed publish. */
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

  /**
   * Test seam: rewrite an entry's age so window expiry can be asserted. `nowMs`
   * is the reference instant, so a spec can run on a fixed clock instead of
   * the wall clock.
   */
  ageItem(key: string, ageMs: number, nowMs: number = Date.now()): boolean {
    const item = this.queue.find(entry => entry.key === key);
    if (!item) return false;
    item.enqueuedAtMs = nowMs - ageMs;
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

export class EventPublisher {
  private nc: NatsConnection | null = null;
  private logger: pino.Logger;
  private caCertPath?: string;
  private isUp = false;
  private readonly changeListeners = new Set<() => void>();
  private connecting = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private draining = false;
  private readonly reconnectBaseMs = parseInt(process.env.NATS_RECONNECT_BASE_MS || '2000', 10);
  private readonly reconnectMaxMs = parseInt(process.env.NATS_RECONNECT_MAX_MS || '30000', 10);
  // Which WhatsApp account this connector instance serves. Personal leaves ids
  // bare; professional namespaces them downstream (see mcp-server accountKey).
  private account = process.env.CONNECTOR_ACCOUNT || 'personal';
  private readonly retainer = new BoundedEventRetainer();

  constructor(
    private natsUrl: string,
    caCertPath?: string
  ) {
    this.caCertPath = caCertPath;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  async connect(): Promise<void> {
    if (this.connecting || this.connected) return;
    this.connecting = true;
    this.stopped = false;
    try {
      const options: ConnectionOptions = {
        servers: this.natsUrl,
        maxReconnectAttempts: -1,
        reconnectTimeWait: this.reconnectBaseMs,
        timeout: 2000,
      };
      if (this.natsUrl.startsWith('tls://') && this.caCertPath) {
        const ca = fs.readFileSync(this.caCertPath, 'utf-8');
        options.tls = { ca };
      }
      this.nc = await connect(options);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.logger.info('Connected to NATS' + (this.caCertPath ? ' with TLS' : ''));
      void this.watchClosed(this.nc);
      void this.watchStatus(this.nc);
      void this.drainRetention();
    } catch (error) {
      this.logger.warn(`NATS unavailable, retaining events until it returns: ${String(error)}`);
      this.connected = false;
      // Clear the in-flight guard BEFORE scheduling: scheduleReconnect()
      // no-ops while `connecting` is true, and `finally` runs only after this
      // catch — leaving the guard set here silently cancelled the retry, so a
      // failed INITIAL connect meant "running without event publishing"
      // forever (observed in prod 2026-07-02: rollout raced a transient NATS
      // refusal and both connectors never published again until restarted).
      this.connecting = false;
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Subscribe to every change of the connection state or of the retention
   * counters; returns the unsubscribe. Lets a caller (the specs) wait for a
   * condition on this publisher by event instead of polling it against a clock.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private get connected(): boolean {
    return this.isUp;
  }

  private set connected(value: boolean) {
    if (this.isUp === value) return;
    this.isUp = value;
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this.changeListeners]) listener();
  }

  /** Counters for the published-vs-received evidence (INFRA-290 criteria B/C). */
  retentionStats(): RetentionStats {
    return this.retainer.stats();
  }

  pendingRetention(): number {
    return this.retainer.pendingSize();
  }

  /**
   * NATS subject for an event. Overridable so a test harness can exercise the
   * real retention path against production NATS under a private subject
   * prefix; production code always lands on the subjects below.
   */
  protected subjectFor(event: WhatsAppEvent): string {
    switch (event.eventType) {
      case EventType.MESSAGE_RECEIVED:
        return `whatsapp.${EventType.MESSAGE_RECEIVED}`;
      case EventType.MESSAGE_UPDATED:
        return `whatsapp.${EventType.MESSAGE_UPDATED}`;
      case EventType.CHAT_UPDATED:
        return `whatsapp.${EventType.CHAT_UPDATED}`;
    }
  }

  publishMessageReceived(event: MessageReceivedEvent): void {
    // Tag the event with this connector's account so the ingestion service
    // namespaces ids correctly (personal stays bare, professional prefixed).
    const tagged: MessageReceivedEvent = { ...event, account: event.account ?? this.account };
    this.emit(tagged, `wa:${tagged.waMessageId}`);
  }

  publishMessageUpdated(event: MessageUpdatedEvent): void {
    // Same account tag as MessageReceived: the bare waMessageId alone does not
    // say whose message it is.
    const tagged: MessageUpdatedEvent = { ...event, account: event.account ?? this.account };
    this.emit(tagged, `wu:${tagged.waMessageId}:${tagged.updateType}`);
  }

  publishChatUpdated(event: ChatUpdatedEvent): void {
    this.emit(event, `cu:${event.waChatId}:${event.updateType}:${stableHash(event)}`);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // A deliberate shutdown must not republish: drop the retainer so a later
    // connect() starts clean.
    this.retainer.clear();
    if (this.nc) {
      await this.nc.close();
      this.nc = null;
      this.logger.info('Disconnected from NATS');
    }
    this.connected = false;
    this.changed();
  }

  /**
   * Publish now, or retain for republication. Never discards while the event
   * is still inside the declared window (INFRA-290 replaced the old
   * "NATS not connected, skipping message event" drop).
   */
  private emit(event: WhatsAppEvent, key: string): void {
    this.retainer.countAccepted();
    const subject = this.subjectFor(event);
    const payload = jsonCodec.encode(event);
    if (this.nc && this.connected) {
      try {
        this.nc.publish(subject, payload);
        this.retainer.countPublished();
        this.changed();
        return;
      } catch (error) {
        this.logger.error(`Failed to publish, retaining event ${key}: ${String(error)}`);
        this.markDisconnected();
      }
    }
    const held = this.retainer.enqueue({ key, subject, payload, enqueuedAtMs: Date.now() });
    if (held && this.retainer.pendingSize() === 1) {
      this.logger.warn(
        { pending: this.retainer.pendingSize() },
        'NATS not connected, event retained for republication'
      );
    }
    this.changed();
  }

  /** Republish everything the retainer is holding, oldest first. */
  private async drainRetention(): Promise<void> {
    if (this.draining || this.stopped || this.retainer.pendingSize() === 0) return;
    this.draining = true;
    let republished = 0;
    try {
      while (this.connected && this.retainer.pendingSize() > 0) {
        const batch = this.retainer.drain();
        if (batch.length === 0) break;
        // Count only after the flush confirms the server took the batch: a
        // failed flush means the batch never left, so it goes back whole and
        // the same event id is never counted (nor published) twice.
        try {
          for (const item of batch) {
            if (!this.nc || !this.connected) throw new Error('NATS connection went away');
            this.nc.publish(item.subject, item.payload);
          }
          if (!this.nc || !this.connected) throw new Error('NATS connection went away');
          await this.flushConfirmed(this.nc, 2000);
        } catch (error) {
          this.retainer.requeueFront(batch);
          this.logger.warn(
            `Retention drain failed, ${batch.length} events requeued: ${String(error)}`
          );
          this.markDisconnected();
          return;
        }
        republished += batch.length;
        this.retainer.countRepublished(batch.length);
        this.changed();
      }
      if (republished > 0) {
        this.logger.info(
          { republished, pending: this.retainer.pendingSize() },
          'Retained events republished'
        );
      }
    } finally {
      this.draining = false;
      this.changed();
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
    // maxReconnectAttempts: -1 it is retrying by itself and `watchStatus` will
    // flip `connected` back on RECONNECT. Nulling it here would leak that
    // client and open a second connection on top of it. Only a connection we
    // already dropped (nc === null) needs our own timer.
    this.connected = false;
    if (!this.nc) this.scheduleReconnect();
  }

  private async watchClosed(nc: NatsConnection): Promise<void> {
    const err = await nc.closed();
    if (this.nc !== nc) return;
    this.connected = false;
    this.nc = null;
    if (err) {
      this.logger.warn(`NATS connection closed: ${String(err)}`);
    } else {
      this.logger.info('NATS connection closed');
    }
    this.scheduleReconnect();
  }

  /**
   * The client's internal reconnect loop. Without this watcher a *brief*
   * outage is invisible: the client buffers outbound writes and `connected`
   * stays true, so events keep going to a dead socket and the retainer never
   * engages (observed live 2026-09-28: a NATS pod deletion only surfaced as a
   * closed connection ~19 s later, after the client gave up). DISCONNECT marks
   * the transport dead — new events then land in the retainer; RECONNECT means
   * the same client is usable again, so drain.
   */
  private async watchStatus(nc: NatsConnection): Promise<void> {
    try {
      const status = nc.status();
      for await (const evt of status) {
        if (this.nc !== nc) return;
        if (evt.type === Events.Disconnect) {
          this.connected = false;
          this.logger.warn('NATS transport disconnected, retaining events until it returns');
        } else if (evt.type === Events.Reconnect) {
          this.connected = true;
          this.reconnectAttempts = 0;
          this.logger.info('NATS reconnected');
          void this.drainRetention();
        }
      }
    } catch {
      /* closed() handles the terminal case and the reconnect schedule */
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.connecting) return;
    // The client owns its own reconnect loop (maxReconnectAttempts: -1). While
    // `nc` still exists it is retrying by itself: opening a second connection
    // here would leak the first one. watchStatus()/watchClosed() drive the
    // recovery instead. Only a null `nc` (failed initial connect, or a
    // connection we already gave up on) needs our own timer.
    if (this.nc) return;
    const delayMs = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * Math.max(1, 2 ** this.reconnectAttempts)
    );
    this.reconnectAttempts += 1;
    this.logger.warn(`Scheduling NATS reconnect in ${delayMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
    (this.reconnectTimer as any).unref?.();
  }
}
