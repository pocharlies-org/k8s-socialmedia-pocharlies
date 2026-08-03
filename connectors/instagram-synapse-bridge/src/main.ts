import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  AckPolicy,
  connect,
  ConnectionOptions,
  Consumer,
  DeliverPolicy,
  JetStreamManager,
  NatsConnection,
  nanos,
} from 'nats';
import pino from 'pino';
import { BridgeConfig, ConfigError, loadConfig } from './config';
import { emptyMetrics, processMessage, BridgeMetrics } from './processor';
import { INSTAGRAM_SKIRMSHOP_DM_STREAM, INSTAGRAM_SKIRMSHOP_DM_SUBJECT } from './schema';
import { SynapseClient } from './synapse-client';

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

class InstagramSynapseBridge {
  private nc: NatsConnection | null = null;
  private consumer: Consumer | null = null;
  private connected = false;
  private consuming = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  readonly metrics: BridgeMetrics = emptyMetrics();

  constructor(
    private readonly config: BridgeConfig,
    private readonly synapse: SynapseClient
  ) {}

  isReady(): boolean {
    return this.connected && this.consumer !== null && this.consuming;
  }

  async start(): Promise<void> {
    if (this.stopped || this.nc) return;
    let opened: NatsConnection | null = null;
    try {
      const options: ConnectionOptions = { servers: this.config.natsUrl, maxReconnectAttempts: -1 };
      if (this.config.natsUrl.startsWith('tls://') && this.config.natsCaCert) {
        options.tls = { ca: readFileSync(this.config.natsCaCert, 'utf8') };
      }
      const nc = await connect(options);
      opened = nc;
      this.nc = nc;
      this.connected = true;
      const manager = await nc.jetstreamManager();
      await this.ensureConsumer(manager);
      this.consumer = await nc
        .jetstream()
        .consumers.get(INSTAGRAM_SKIRMSHOP_DM_STREAM, this.config.durableName);
      this.consuming = true;
      void this.consume(this.consumer, nc);
      void this.watchClosed(nc);
      logger.info(
        {
          stream: INSTAGRAM_SKIRMSHOP_DM_STREAM,
          subject: INSTAGRAM_SKIRMSHOP_DM_SUBJECT,
          durable: this.config.durableName,
        },
        'Instagram Synapse bridge ready'
      );
    } catch (error) {
      this.clearConnection();
      if (opened) {
        try {
          await opened.close();
        } catch {
          // Preserve the original startup error; reconnect remains scheduled.
        }
      }
      logger.warn(
        { error: error instanceof Error ? error.name : 'unknown' },
        'Instagram bridge unavailable; reconnect scheduled'
      );
      this.scheduleReconnect();
    }
  }

  private async ensureConsumer(manager: JetStreamManager): Promise<void> {
    try {
      const info = await manager.consumers.info(
        INSTAGRAM_SKIRMSHOP_DM_STREAM,
        this.config.durableName
      );
      if (
        info.config.ack_policy !== AckPolicy.Explicit ||
        info.config.filter_subject !== INSTAGRAM_SKIRMSHOP_DM_SUBJECT
      ) {
        throw new Error('existing consumer has an unsafe delivery configuration');
      }
      return;
    } catch (error) {
      // A valid existing consumer has already returned. `add` is deliberately
      // attempted only for a missing consumer; if the previous error was an
      // authorization/transport/config problem, add fails and startup remains
      // fail-closed instead of consuming a different subject.
      if (
        error instanceof Error &&
        error.message === 'existing consumer has an unsafe delivery configuration'
      ) {
        throw error;
      }
    }
    await manager.consumers.add(INSTAGRAM_SKIRMSHOP_DM_STREAM, {
      durable_name: this.config.durableName,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: INSTAGRAM_SKIRMSHOP_DM_SUBJECT,
      ack_wait: nanos(this.config.ackWaitMs),
      max_deliver: -1,
    });
  }

  private async consume(consumer: Consumer, nc: NatsConnection): Promise<void> {
    try {
      const messages = await consumer.consume({
        max_messages: 10,
        abort_on_missing_resource: true,
      });
      for await (const message of messages) {
        // If this consumer was superseded by a reconnect, do not ack against
        // its old iterator. JetStream will redeliver it to the active one.
        if (this.nc !== nc || this.stopped) break;
        await processMessage(message, this.synapse, this.config.retryDelayMs, this.metrics);
      }
    } catch (error) {
      if (!this.stopped && this.nc === nc) {
        logger.warn(
          { error: error instanceof Error ? error.name : 'unknown' },
          'Instagram consumer stopped; reconnect scheduled'
        );
        this.clearConnection();
        try {
          await nc.close();
        } catch {
          // The consumer failure is already recorded without event contents.
        }
        this.scheduleReconnect();
      }
    } finally {
      if (this.nc === nc) this.consuming = false;
    }
  }

  private async watchClosed(nc: NatsConnection): Promise<void> {
    const error = await nc.closed();
    if (this.nc !== nc) return;
    this.clearConnection();
    if (!this.stopped) {
      logger.warn(
        { error: error instanceof Error ? error.name : undefined },
        'Instagram NATS connection closed; reconnect scheduled'
      );
      this.scheduleReconnect();
    }
  }

  private clearConnection(): void {
    this.connected = false;
    this.consuming = false;
    this.consumer = null;
    this.nc = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, 5_000);
    this.reconnectTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const nc = this.nc;
    this.clearConnection();
    if (nc) await nc.close();
  }
}

function startHealthServer(
  port: number,
  bridge: InstagramSynapseBridge
): ReturnType<typeof createServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health' || req.url === '/healthz') {
      const ready = bridge.isReady();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'degraded', consumerReady: ready }));
      return;
    }
    if (req.url === '/status') {
      const ready = bridge.isReady();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'degraded', metrics: bridge.metrics }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(port, () => logger.info({ port }, 'health server listening'));
  return server;
}

async function main(): Promise<void> {
  let config: BridgeConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'invalid configuration';
    logger.fatal({ error: message }, 'Instagram bridge refused to start');
    process.exitCode = 1;
    return;
  }
  const bridge = new InstagramSynapseBridge(
    config,
    new SynapseClient({
      url: config.synapseWebhookUrl,
      secret: config.instagramWebhookSecret,
      logger,
    })
  );
  const server = startHealthServer(config.port, bridge);
  await bridge.start();

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close();
    void bridge.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
