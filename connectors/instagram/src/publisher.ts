/**
 * Instagram Event Publisher — Multi-account.
 * NATS subjects include account name: instagram.{account}.{type}.received
 */

import {
  connect,
  ConnectionOptions,
  JetStreamClient,
  JetStreamManager,
  JSONCodec,
  NatsConnection,
  RetentionPolicy,
  StorageType,
} from 'nats';
import pino from 'pino';
import type { WebhookEvent } from './webhook';
import { publishWithAcknowledgement } from './publisher-ack';

const jsonCodec = JSONCodec();

const logger = pino(
  process.env.NODE_ENV === 'test'
    ? { level: 'silent' }
    : { transport: { target: 'pino-pretty', options: { colorize: true } } }
);

export class InstagramEventPublisher {
  private nc: NatsConnection | null = null;
  private js: JetStreamClient | null = null;
  private connected = false;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private readonly reconnectDelayMs = 10_000;

  constructor(
    private natsUrl: string,
    private natsCaCert?: string,
    private readonly publishAck?: (
      subject: string,
      payload: Uint8Array,
      messageId: string
    ) => Promise<void>
  ) {}

  async connect(): Promise<void> {
    if (this.connected || this.connecting || this.shuttingDown) {
      return;
    }
    this.connecting = true;
    try {
      const options: ConnectionOptions = { servers: this.natsUrl };
      if (this.natsUrl.startsWith('tls://') && this.natsCaCert && this.natsCaCert !== 'none') {
        const fs = await import('fs');
        const ca = fs.readFileSync(this.natsCaCert, 'utf-8');
        options.tls = { ca };
      }
      this.nc = await connect(options);
      const manager = await this.nc.jetstreamManager();
      await ensureInstagramDmStream(manager);
      this.js = this.nc.jetstream();
      this.connected = true;
      logger.info('Connected to NATS');
      this.nc
        .closed()
        .then(error => {
          this.connected = false;
          this.nc = null;
          this.js = null;
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
          this.js = null;
          if (!this.shuttingDown) {
            logger.warn(`NATS connection close watcher failed: ${String(error)}`);
            this.scheduleReconnect();
          }
        });
    } catch (error) {
      logger.warn(`NATS unavailable, will retry event publishing connection: ${String(error)}`);
      this.connected = false;
      if (this.nc) {
        try {
          await this.nc.close();
        } catch {
          // The original connection/JetStream error is the actionable failure.
        }
        this.nc = null;
      }
      this.js = null;
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private readonly delivered = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  private readonly dedupeTtlMs = 24 * 60 * 60 * 1000;

  publish(account: string, event: WebhookEvent): Promise<boolean> {
    const key = `${account}:${event.messageId ?? ''}`;
    if (!event.messageId) return Promise.resolve(false);
    if (this.delivered.has(key)) return Promise.resolve(true);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const result = this.publishOnce(account, event, key);
    this.inflight.set(key, result);
    void result.finally(() => this.inflight.delete(key));
    return result;
  }

  private async publishOnce(account: string, event: WebhookEvent, key: string): Promise<boolean> {
    if ((!this.js || !this.connected) && !this.publishAck) {
      this.scheduleReconnect();
      logger.warn('NATS unavailable; refusing webhook acknowledgement');
      return false;
    }

    const subject = `instagram.${account}.${event.type}.received`;
    try {
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
      if (this.publishAck) {
        await publishWithAcknowledgement(this.publishAck, subject, payload, key);
      } else {
        await this.js!.publish(subject, payload, { msgID: key });
      }
      this.delivered.set(key, Date.now());
      this.pruneDelivered();
      logger.debug({ subject, account }, 'Event published to NATS');
      return true;
    } catch (error) {
      logger.error(`Failed to publish to NATS: ${String(error)}`);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.nc) {
      await this.nc.close();
      this.nc = null;
      this.js = null;
      logger.info('Disconnected from NATS');
    }
  }

  isReady(): boolean {
    return this.connected && this.js !== null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.connected || this.connecting || this.shuttingDown) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.reconnectDelayMs);
  }

  private pruneDelivered(): void {
    const cutoff = Date.now() - this.dedupeTtlMs;
    for (const [key, completedAt] of this.delivered) {
      if (completedAt < cutoff) this.delivered.delete(key);
    }
  }
}

export const INSTAGRAM_SKIRMSHOP_DM_STREAM = 'INSTAGRAM_SKIRMSHOP_DM';
export const INSTAGRAM_SKIRMSHOP_DM_SUBJECT = 'instagram.skirmshop.dm.received';

async function ensureInstagramDmStream(manager: JetStreamManager): Promise<void> {
  try {
    await manager.streams.info(INSTAGRAM_SKIRMSHOP_DM_STREAM);
  } catch {
    await manager.streams.add({
      name: INSTAGRAM_SKIRMSHOP_DM_STREAM,
      subjects: [INSTAGRAM_SKIRMSHOP_DM_SUBJECT],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: 24 * 60 * 60 * 1_000_000_000,
      duplicate_window: 24 * 60 * 60 * 1_000_000_000,
    });
  }
}
