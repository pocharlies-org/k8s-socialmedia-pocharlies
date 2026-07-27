import { connect, NatsConnection, JSONCodec, Codec, ConnectionOptions } from 'nats';
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

export class EventPublisher {
  private nc: NatsConnection | null = null;
  private logger: pino.Logger;
  private caCertPath?: string;
  private connected = false;
  private connecting = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly reconnectBaseMs = parseInt(process.env.NATS_RECONNECT_BASE_MS || '2000', 10);
  private readonly reconnectMaxMs = parseInt(process.env.NATS_RECONNECT_MAX_MS || '30000', 10);
  // Which WhatsApp account this connector instance serves. Personal leaves ids
  // bare; professional namespaces them downstream (see mcp-server accountKey).
  private account = process.env.CONNECTOR_ACCOUNT || 'personal';

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
    } catch (error) {
      this.logger.warn(`NATS unavailable, running without event publishing: ${String(error)}`);
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

  publishMessageReceived(event: MessageReceivedEvent): void {
    if (!this.nc || !this.connected) {
      this.logger.debug('NATS not connected, skipping message event');
      return;
    }
    try {
      // Tag the event with this connector's account so the ingestion service
      // namespaces ids correctly (personal stays bare, professional prefixed).
      const tagged = { ...event, account: event.account ?? this.account };
      this.nc.publish(`whatsapp.${EventType.MESSAGE_RECEIVED}`, jsonCodec.encode(tagged));
    } catch (error) {
      this.logger.error(`Failed to publish: ${String(error)}`);
      this.markDisconnected();
    }
  }

  publishMessageUpdated(event: MessageUpdatedEvent): void {
    if (!this.nc || !this.connected) return;
    try {
      this.nc.publish(`whatsapp.${EventType.MESSAGE_UPDATED}`, jsonCodec.encode(event));
    } catch (error) {
      this.logger.error(`Failed to publish: ${String(error)}`);
      this.markDisconnected();
    }
  }

  publishChatUpdated(event: ChatUpdatedEvent): void {
    if (!this.nc || !this.connected) return;
    try {
      this.nc.publish(`whatsapp.${EventType.CHAT_UPDATED}`, jsonCodec.encode(event));
    } catch (error) {
      this.logger.error(`Failed to publish: ${String(error)}`);
      this.markDisconnected();
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.nc) {
      await this.nc.close();
      this.nc = null;
      this.logger.info('Disconnected from NATS');
    }
    this.connected = false;
  }

  private markDisconnected(): void {
    if (!this.connected && this.reconnectTimer) return;
    this.connected = false;
    this.nc = null;
    this.scheduleReconnect();
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

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.connecting) return;
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
