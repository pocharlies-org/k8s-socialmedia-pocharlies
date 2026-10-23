import * as fs from 'fs';
import { connect, NatsConnection, ConnectionOptions, Subscription } from 'nats';
import type pino from 'pino';

/**
 * NATS core subscription of a bridge (DGX-1235 B0, moved from
 * whatsapp-synapse-bridge/src/main.ts): connect, subscribe each subject in the
 * queue group, reconnect with exponential backoff, drain on stop. One
 * sequential loop per subject: `onMessage` is awaited before the next message
 * of that subject. NATS core is at-most-once: what is lost while disconnected
 * is not replayed.
 */
export interface NatsSubscriberOptions {
  natsUrl: string;
  /** CA cert path for tls:// NATS. */
  natsCaCert?: string;
  queue: string;
  subjects: string[];
  logger: pino.Logger;
  onMessage: (subject: string, data: Uint8Array) => Promise<void>;
  /** Reconnect backoff; default NATS_RECONNECT_BASE_MS / NATS_RECONNECT_MAX_MS (2 s / 30 s). */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export class NatsSubscriber {
  private nc: NatsConnection | null = null;
  private subs: Subscription[] = [];
  private connected = false;
  private connecting = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  constructor(private readonly opts: NatsSubscriberOptions) {
    this.reconnectBaseMs = opts.reconnectBaseMs ?? parseInt(process.env.NATS_RECONNECT_BASE_MS || '2000', 10);
    this.reconnectMaxMs = opts.reconnectMaxMs ?? parseInt(process.env.NATS_RECONNECT_MAX_MS || '30000', 10);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    if (this.connecting || this.connected) return;
    this.connecting = true;
    this.stopped = false;
    const logger = this.opts.logger;
    let failed = false;
    try {
      const options: ConnectionOptions = {
        servers: this.opts.natsUrl,
        maxReconnectAttempts: -1,
        reconnectTimeWait: this.reconnectBaseMs,
        timeout: 2000,
      };
      if (this.opts.natsUrl.startsWith('tls://') && this.opts.natsCaCert) {
        options.tls = { ca: fs.readFileSync(this.opts.natsCaCert, 'utf-8') };
      }
      this.nc = await connect(options);
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info(
        { subject: this.opts.subjects.join(','), queue: this.opts.queue },
        'connected to NATS, subscribing'
      );
      for (const subject of this.opts.subjects) this.subscribe(this.nc, subject);
      void this.watchClosed(this.nc);
    } catch (error) {
      logger.warn({ err: String(error) }, 'NATS unavailable; scheduling reconnect');
      this.connected = false;
      failed = true;
    } finally {
      this.connecting = false;
    }
    // After the guard is down: scheduleReconnect() no-ops while connecting.
    if (failed) this.scheduleReconnect();
  }

  private subscribe(nc: NatsConnection, subject: string): void {
    const sub = nc.subscribe(subject, { queue: this.opts.queue });
    this.subs.push(sub);
    void (async (): Promise<void> => {
      for await (const msg of sub) {
        await this.opts.onMessage(subject, msg.data);
      }
    })();
  }

  private async watchClosed(nc: NatsConnection): Promise<void> {
    const err = await nc.closed();
    if (this.nc !== nc) return;
    this.connected = false;
    this.nc = null;
    this.subs = [];
    if (err) this.opts.logger.warn({ err: String(err) }, 'NATS connection closed');
    else this.opts.logger.info('NATS connection closed');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.connecting) return;
    const delayMs = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * Math.max(1, 2 ** this.reconnectAttempts)
    );
    this.reconnectAttempts += 1;
    this.opts.logger.warn({ delayMs }, 'scheduling NATS reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, delayMs);
    (this.reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const sub of this.subs) {
      try {
        await sub.drain();
      } catch {
        /* ignore drain errors on shutdown */
      }
    }
    if (this.nc) {
      await this.nc.close();
      this.nc = null;
    }
    this.connected = false;
  }
}
