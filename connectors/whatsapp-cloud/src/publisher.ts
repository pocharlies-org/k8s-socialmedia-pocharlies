import { connect, NatsConnection, JSONCodec, Codec, ConnectionOptions } from 'nats';
import pino from 'pino';
import * as fs from 'fs';
import { EventType, MessageReceivedEvent, WhatsAppEvent } from '@mcp-socialmedia/shared';

const jsonCodec: Codec<WhatsAppEvent> = JSONCodec();

export class WhatsAppCloudPublisher {
  private nc: NatsConnection | null = null;
  private connected = false;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

  constructor(
    private natsUrl: string,
    private caCertPath?: string
  ) {}

  async connect(): Promise<void> {
    if (this.connected || this.connecting || this.stopped) return;
    this.connecting = true;
    try {
      const options: ConnectionOptions = {
        servers: this.natsUrl,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
        timeout: 2000,
      };
      if (this.natsUrl.startsWith('tls://') && this.caCertPath && this.caCertPath !== 'none') {
        options.tls = { ca: fs.readFileSync(this.caCertPath, 'utf8') };
      }
      this.nc = await connect(options);
      this.connected = true;
      this.logger.info('Connected to NATS');
      void this.watchClosed(this.nc);
    } catch (error) {
      this.logger.warn(`NATS unavailable, running without event publishing: ${String(error)}`);
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
      this.logger.debug('NATS not connected, skipping WhatsApp Cloud message event');
      this.scheduleReconnect();
      return;
    }
    try {
      this.nc.publish(`whatsapp.${EventType.MESSAGE_RECEIVED}`, jsonCodec.encode(event));
    } catch (error) {
      this.logger.error(`Failed to publish WhatsApp Cloud event: ${String(error)}`);
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
    }
    this.connected = false;
  }

  private async watchClosed(nc: NatsConnection): Promise<void> {
    const error = await nc.closed();
    if (this.nc !== nc) return;
    this.connected = false;
    this.nc = null;
    if (error) {
      this.logger.warn(`NATS connection closed: ${String(error)}`);
    }
    this.scheduleReconnect();
  }

  private markDisconnected(): void {
    this.connected = false;
    this.nc = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.connected || this.connecting || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 5000);
    this.reconnectTimer.unref?.();
  }
}
