import { connect, NatsConnection, JSONCodec, Subscription, ConnectionOptions } from 'nats';
import { Pool } from 'pg';
import { EmbeddingService } from '../../application/embedding.service';
import { EventType } from '@mcp-socialmedia/shared';
import { accountKey, normalizeAccount } from '../../domain/account';
import pino from 'pino';
import * as fs from 'fs';

interface MessageReceivedEvent {
  eventType: string;
  conversationId: string;
  // WhatsApp lo trae; Telegram usa telegramMessageId y conversationId es el chat pelado.
  waMessageId?: string;
  telegramMessageId?: string;
  // El conector estampa su cuenta (CONNECTOR_ACCOUNT). Omitted = 'personal'.
  account?: string;
}

export class EmbeddingJob {
  private nc: NatsConnection | null = null;
  private subscriptions: Subscription[] = [];
  private embeddingService: EmbeddingService;
  private logger: pino.Logger;
  private caCertPath?: string;

  constructor(
    private natsUrl: string,
    private dbClient: Pool,
    openaiApiKey: string,
    encryptionKey: string,
    caCertPath?: string
  ) {
    this.caCertPath = caCertPath;
    this.embeddingService = new EmbeddingService(openaiApiKey, dbClient, encryptionKey);
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  async start(): Promise<void> {
    try {
      const options: ConnectionOptions = { servers: this.natsUrl };

      // Configure TLS if using tls:// protocol and CA cert is provided
      if (this.natsUrl.startsWith('tls://') && this.caCertPath) {
        const ca = fs.readFileSync(this.caCertPath, 'utf-8');
        options.tls = {
          ca: ca,
        };
      }

      this.nc = await connect(options);
      this.logger.info('Embedding job connected to NATS' + (this.caCertPath ? ' with TLS' : ''));

      // Mensajes nuevos de los dos canales. Antes solo WhatsApp, y con el id
      // pelado del evento: las cuentas que van namespaced (professional, leila)
      // y todo Telegram no acertaban nunca la fila, así que se quedaban sin
      // embedding sin decir nada (medido 04-10: 0 de 17.301 mensajes de 7 días).
      const handler = this.onMessage.bind(this);
      for (const subject of [
        `whatsapp.${EventType.MESSAGE_RECEIVED}`,
        `telegram.${EventType.TELEGRAM_MESSAGE_RECEIVED}`,
      ]) {
        this.subscriptions.push(this.nc.subscribe(subject, { callback: handler }));
      }

      this.logger.info('Embedding job started');
    } catch (error) {
      this.logger.error(`Failed to start embedding job: ${error}`);
      throw error;
    }
  }

  /** La clave opaca con la que el mensaje está en `messages` (migración 002):
   * `personal` sin prefijo, las demás cuentas namespaceadas por el `account` que
   * estampa el conector. Telegram se guarda como `tg_<chat>_<mensaje>`. */
  static messageKeyFor(event: MessageReceivedEvent): string {
    const bare = event.telegramMessageId
      ? `tg_${event.conversationId}_${event.telegramMessageId}`
      : event.waMessageId;
    if (!bare) return '';
    return accountKey(normalizeAccount(event.account), bare);
  }

  private async onMessage(err: Error | null, msg: { data: Uint8Array }): Promise<void> {
    if (err) {
      this.logger.error(`Error in embedding job subscription: ${err?.message ?? String(err)}`);
      return;
    }

    try {
      const event = JSONCodec<MessageReceivedEvent>().decode(msg.data);
      const key = EmbeddingJob.messageKeyFor(event);
      if (key) {
        const result = await this.dbClient.query(
          `SELECT id FROM messages WHERE wa_message_id = $1 LIMIT 1`,
          [key]
        );

        if (result.rows.length > 0) {
          // Process in background (don't await to avoid blocking)
          this.embeddingService.processMessage(result.rows[0].id).catch(error => {
            this.logger.error(`Error processing embedding: ${error}`);
          });
        } else {
          // Sin esto el agujero es mudo: el evento llega, no hay fila y nadie se entera.
          this.logger.warn(`Embedding job: ningún mensaje con wa_message_id=${key}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error handling embedding job event: ${error}`);
    }
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      await sub.drain();
    }
    this.subscriptions = [];

    if (this.nc) {
      await this.nc.close();
      this.nc = null;
      this.logger.info('Embedding job stopped');
    }
  }
}
