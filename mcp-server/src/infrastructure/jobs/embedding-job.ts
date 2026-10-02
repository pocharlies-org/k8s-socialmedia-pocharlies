import { connect, NatsConnection, JSONCodec, Subscription, ConnectionOptions } from 'nats';
import { Pool } from 'pg';
import { EmbeddingService } from '../../application/embedding.service';
import { EventType } from '@mcp-socialmedia/shared';
import pino from 'pino';
import * as fs from 'fs';
import { accountKey, normalizeAccount } from '../../domain/account';
import { isWhatsAppUpdate } from '../../domain/whatsapp-surface';

interface MessageReceivedEvent {
  eventType: string;
  account?: string;
  conversationId: string;
  waMessageId: string;
}

export class EmbeddingJob {
  private nc: NatsConnection | null = null;
  private subscription: Subscription | null = null;
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

      // Subscribe to message received events
      this.subscription = this.nc.subscribe(`whatsapp.${EventType.MESSAGE_RECEIVED}`, {
        callback: async (err, msg) => {
          if (err) {
            this.logger.error(
              `Error in embedding job subscription: ${err?.message ?? String(err)}`
            );
            return;
          }

          try {
            const event = JSONCodec<MessageReceivedEvent>().decode(msg.data);

            await this.handleMessageReceived(event);
          } catch (error) {
            this.logger.error(`Error handling embedding job event: ${error}`);
          }
        },
      });

      this.logger.info('Embedding job started');
    } catch (error) {
      this.logger.error(`Failed to start embedding job: ${error}`);
      throw error;
    }
  }

  async handleMessageReceived(event: MessageReceivedEvent): Promise<void> {
    if (isWhatsAppUpdate(event.conversationId)) return;
    const account = normalizeAccount(event.account, 'whatsapp');
    const result = await this.dbClient.query(
      `SELECT id FROM messages WHERE account = $1 AND platform = 'whatsapp'
       AND conversation_id = $2 AND wa_message_id = $3
       AND (is_deleted IS NULL OR is_deleted = false) LIMIT 1`,
      [account, accountKey(account, event.conversationId), accountKey(account, event.waMessageId)]
    );
    if (result.rows.length > 0) {
      await this.embeddingService.processMessage(result.rows[0].id);
    }
  }

  async stop(): Promise<void> {
    if (this.subscription) {
      await this.subscription.drain();
      this.subscription = null;
    }

    if (this.nc) {
      await this.nc.close();
      this.nc = null;
      this.logger.info('Embedding job stopped');
    }
  }
}
