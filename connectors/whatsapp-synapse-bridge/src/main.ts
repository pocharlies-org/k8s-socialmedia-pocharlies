import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as fs from 'fs';
import {
  connect,
  NatsConnection,
  JSONCodec,
  Codec,
  ConnectionOptions,
  Subscription,
} from 'nats';
import pino from 'pino';
import { MessageReceivedEvent } from '@mcp-socialmedia/shared';
import { loadConfig, BridgeConfig, ConfigError } from './config';
import { shouldForward } from './filter';
import { DedupCache } from './dedup';
import { MeCache } from './me-cache';
import { GatewayClient } from './gateway-client';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

const jsonCodec: Codec<MessageReceivedEvent> = JSONCodec();

/**
 * In-process counters for /status + observability. PII-free.
 */
const metrics = {
  received: 0,
  forwarded: 0,
  /** Subset of `forwarded` that were own-outbound team touches (F0.5). */
  forwardedFromMe: 0,
  droppedByReason: new Map<string, number>(),
  gatewayDelivered: 0,
  gatewayDroppedAuth: 0,
  gatewayDroppedBadRequest: 0,
  gatewayExhausted: 0,
};

function countDrop(reason: string): void {
  metrics.droppedByReason.set(reason, (metrics.droppedByReason.get(reason) ?? 0) + 1);
}

class Bridge {
  private nc: NatsConnection | null = null;
  private sub: Subscription | null = null;
  private connected = false;
  private connecting = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly reconnectBaseMs = parseInt(process.env.NATS_RECONNECT_BASE_MS || '2000', 10);
  private readonly reconnectMaxMs = parseInt(process.env.NATS_RECONNECT_MAX_MS || '30000', 10);

  constructor(
    private readonly config: BridgeConfig,
    private readonly meCache: MeCache,
    private readonly dedup: DedupCache,
    private readonly gateway: GatewayClient
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    if (this.connecting || this.connected) return;
    this.connecting = true;
    this.stopped = false;
    try {
      const options: ConnectionOptions = {
        servers: this.config.natsUrl,
        maxReconnectAttempts: -1,
        reconnectTimeWait: this.reconnectBaseMs,
        timeout: 2000,
      };
      if (this.config.natsUrl.startsWith('tls://') && this.config.natsCaCert) {
        options.tls = { ca: fs.readFileSync(this.config.natsCaCert, 'utf-8') };
      }
      this.nc = await connect(options);
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info(
        { subject: 'whatsapp.MessageReceived', queue: this.config.natsQueueGroup },
        'connected to NATS, subscribing'
      );
      this.subscribe(this.nc);
      void this.watchClosed(this.nc);
    } catch (error) {
      logger.warn({ err: String(error) }, 'NATS unavailable; scheduling reconnect');
      this.connected = false;
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private subscribe(nc: NatsConnection): void {
    this.sub = nc.subscribe('whatsapp.MessageReceived', { queue: this.config.natsQueueGroup });
    void (async (): Promise<void> => {
      for await (const msg of this.sub as Subscription) {
        let event: MessageReceivedEvent;
        try {
          event = jsonCodec.decode(msg.data);
        } catch (error) {
          // Undecodable payload => fail-closed drop.
          countDrop('decode-error');
          logger.error({ err: String(error) }, 'FAIL-CLOSED: undecodable NATS payload, dropping');
          continue;
        }
        await this.handle(event);
      }
    })();
  }

  private async handle(event: MessageReceivedEvent): Promise<void> {
    metrics.received++;
    // PII-safe context only.
    const waMessageId = (event?.waMessageId || '').trim();
    const account = event?.account;

    let ownJid = '';
    try {
      ownJid = await this.meCache.getOwnJid();
    } catch (error) {
      // getOwnJid never throws, but be defensive: unknown own JID => fail closed.
      logger.error({ err: String(error) }, 'FAIL-CLOSED: getOwnJid threw, dropping');
    }

    const decision = shouldForward(event, ownJid, this.dedup);
    if (!decision.forward) {
      countDrop(decision.reason);
      logger.info({ waMessageId, account, reason: decision.reason }, 'dropped');
      return;
    }

    // F0.5: our own outbound (operator replying from the phone) is forwarded
    // FLAGGED so downstream treats it as a team touch. Stamp the flag
    // explicitly — the own-JID-derived case may lack it on the wire.
    const outbound: MessageReceivedEvent =
      decision.fromMe === true ? { ...event, fromMe: true } : event;

    const result = await this.gateway.forward(outbound, { waMessageId, account });
    if (result.ok) {
      metrics.forwarded++;
      if (decision.fromMe === true) metrics.forwardedFromMe++;
      metrics.gatewayDelivered++;
    } else if (result.outcome === 'dropped-auth') {
      metrics.gatewayDroppedAuth++;
    } else if (result.outcome === 'dropped-bad-request') {
      metrics.gatewayDroppedBadRequest++;
    } else {
      metrics.gatewayExhausted++;
    }
  }

  private async watchClosed(nc: NatsConnection): Promise<void> {
    const err = await nc.closed();
    if (this.nc !== nc) return;
    this.connected = false;
    this.nc = null;
    this.sub = null;
    if (err) logger.warn({ err: String(err) }, 'NATS connection closed');
    else logger.info('NATS connection closed');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.connecting) return;
    const delayMs = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * Math.max(1, 2 ** this.reconnectAttempts)
    );
    this.reconnectAttempts += 1;
    logger.warn({ delayMs }, 'scheduling NATS reconnect');
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
    try {
      if (this.sub) await this.sub.drain();
    } catch {
      /* ignore drain errors on shutdown */
    }
    if (this.nc) {
      await this.nc.close();
      this.nc = null;
    }
    this.connected = false;
  }
}

function statusPayload(bridge: Bridge, meCache: MeCache, dedup: DedupCache): Record<string, unknown> {
  return {
    status: bridge.isConnected() && meCache.isReady() ? 'ok' : 'degraded',
    service: 'whatsapp-synapse-bridge',
    natsConnected: bridge.isConnected(),
    ownJidKnown: meCache.isReady(),
    dedupSize: dedup.size(),
    metrics: {
      received: metrics.received,
      forwarded: metrics.forwarded,
      forwardedFromMe: metrics.forwardedFromMe,
      gatewayDelivered: metrics.gatewayDelivered,
      gatewayDroppedAuth: metrics.gatewayDroppedAuth,
      gatewayDroppedBadRequest: metrics.gatewayDroppedBadRequest,
      gatewayExhausted: metrics.gatewayExhausted,
      droppedByReason: Object.fromEntries(metrics.droppedByReason),
    },
  };
}

function startHealthServer(
  port: number,
  bridge: Bridge,
  meCache: MeCache,
  dedup: DedupCache
): ReturnType<typeof createServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/';
    if (url === '/health' || url === '/healthz') {
      // Liveness/readiness: process is up + NATS reachable. Own-JID readiness is
      // surfaced separately so a missing /me does not crashloop the pod, but the
      // filter still fails closed until /me succeeds.
      const ready = bridge.isConnected();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'degraded', natsConnected: ready }));
      return;
    }
    if (url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(statusPayload(bridge, meCache, dedup)));
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
    if (error instanceof ConfigError) {
      logger.fatal({ err: error.message }, 'invalid configuration; refusing to start');
    } else {
      logger.fatal({ err: String(error) }, 'failed to load configuration');
    }
    process.exit(1);
    return;
  }

  const meCache = new MeCache({
    connectorUrl: config.connectorUrl,
    connectorSharedSecret: config.connectorSharedSecret,
    ttlMs: config.meCacheTtlMs,
    logger,
  });
  const dedup = new DedupCache(config.dedupTtlMs, config.dedupMax);
  const gateway = new GatewayClient({
    url: config.gatewayWebhookUrl,
    secret: config.whatsappWebhookSecret,
    logger,
  });
  const bridge = new Bridge(config, meCache, dedup, gateway);

  const server = startHealthServer(config.port, bridge, meCache, dedup);

  // Warm the own-JID cache eagerly (best effort; filter stays fail-closed until ok).
  void meCache.getOwnJid();

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
