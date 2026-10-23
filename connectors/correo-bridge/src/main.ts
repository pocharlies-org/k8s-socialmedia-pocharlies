import { createServer, IncomingMessage, ServerResponse } from 'http';
import pino from 'pino';
import { DedupCache, MeCache, NatsSubscriber } from '@mcp-socialmedia/shared';
import { loadConfig, BridgeConfig, ConfigError } from './config';
import { procesar, SUBJECT_TELEGRAM, SUBJECT_WHATSAPP } from './filter';
import { Entrega } from './entrega';
import { IndiceRefs } from './refs';
import { ClienteConectores } from './conectores';
import { crearLectura } from './lectura';

/**
 * correo-bridge (DGX-1235 B1): provider of correo.connector.v1, on the NATS
 * scaffolding of shared/src/bridge. Stateless (no Postgres): NATS in,
 * POST /v2/mensajes to the correo core out, and the live read routes. It never
 * sends to a customer (that is B2).
 */

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

/** PII-free counters for /status and /metrics. */
const metrics = {
  received: 0,
  forwarded: 0,
  droppedByReason: new Map<string, number>(),
};

function countDrop(reason: string): void {
  metrics.droppedByReason.set(reason, (metrics.droppedByReason.get(reason) ?? 0) + 1);
}

class Bridge {
  // One sequential loop per subject (NatsSubscriber): a dead core costs each
  // loop at most TOPE_MS per event (entrega.ts), never an unbounded block.
  private readonly nats: NatsSubscriber;

  constructor(
    private readonly config: BridgeConfig,
    private readonly meCache: MeCache,
    private readonly dedup: DedupCache,
    private readonly refs: IndiceRefs,
    private readonly entrega: Entrega
  ) {
    this.nats = new NatsSubscriber({
      natsUrl: config.natsUrl,
      natsCaCert: config.natsCaCert,
      queue: config.natsQueueGroup,
      subjects: [SUBJECT_WHATSAPP, SUBJECT_TELEGRAM],
      logger,
      onMessage: (subject, data) => this.handle(subject, data),
    });
  }

  isConnected(): boolean {
    return this.nats.isConnected();
  }

  start(): Promise<void> {
    return this.nats.start();
  }

  stop(): Promise<void> {
    return this.nats.stop();
  }

  private async handle(subject: string, data: Uint8Array): Promise<void> {
    metrics.received++;
    const ownJid = subject === SUBJECT_WHATSAPP ? await this.meCache.getOwnJid() : '';
    const r = procesar(subject, data, ownJid, this.dedup);
    if (!r.forward) {
      countDrop(r.reason);
      logger.info({ subject, reason: r.reason }, 'dropped');
      return;
    }
    metrics.forwarded++;
    this.refs.guardar(r.cuerpo.ref, r.cuerpo.hilo_ref);
    await this.entrega.entregar(this.config.conectorPorCanal[r.canal], r.cuerpo);
  }
}

function statusPayload(bridge: Bridge, meCache: MeCache, dedup: DedupCache, refs: IndiceRefs, entrega: Entrega): Record<string, unknown> {
  return {
    status: bridge.isConnected() && meCache.isReady() ? 'ok' : 'degraded',
    service: 'correo-bridge',
    natsConnected: bridge.isConnected(),
    ownJidKnown: meCache.isReady(),
    dedupSize: dedup.size(),
    refsSize: refs.size(),
    metrics: {
      received: metrics.received,
      forwarded: metrics.forwarded,
      ...entrega.contadores,
      droppedByReason: Object.fromEntries(metrics.droppedByReason),
    },
  };
}

/** Prometheus text for the VMServiceScrape; the alert reads correo_bridge_agotados_total. */
function metricsText(entrega: Entrega): string {
  const c = entrega.contadores;
  const lineas = [
    '# HELP correo_bridge_agotados_total Messages discarded after 3 attempts / 30 s without the correo core.',
    '# TYPE correo_bridge_agotados_total counter',
    `correo_bridge_agotados_total ${c.agotados}`,
    '# HELP correo_bridge_entregas_total Messages the correo core answered, by result.',
    '# TYPE correo_bridge_entregas_total counter',
    `correo_bridge_entregas_total{resultado="entregado"} ${c.entregados}`,
    `correo_bridge_entregas_total{resultado="duplicado"} ${c.duplicados}`,
    `correo_bridge_entregas_total{resultado="rechazado"} ${c.rechazados}`,
    '# HELP correo_bridge_recibidos_total NATS messages received.',
    '# TYPE correo_bridge_recibidos_total counter',
    `correo_bridge_recibidos_total ${metrics.received}`,
    '# HELP correo_bridge_descartados_total NATS messages dropped by the filter, by reason.',
    '# TYPE correo_bridge_descartados_total counter',
    ...[...metrics.droppedByReason].map(([r, n]) => `correo_bridge_descartados_total{motivo="${r}"} ${n}`),
  ];
  return `${lineas.join('\n')}\n`;
}

async function main(): Promise<void> {
  let config: BridgeConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) logger.fatal({ err: error.message }, 'invalid configuration; refusing to start');
    else logger.fatal({ err: String(error) }, 'failed to load configuration');
    process.exit(1);
    return;
  }

  const meCache = new MeCache({
    connectorUrl: config.whatsappConnectorUrl,
    connectorSharedSecret: config.connectorSharedSecret,
    ttlMs: config.meCacheTtlMs,
    logger,
  });
  const dedup = new DedupCache(config.dedupTtlMs, config.dedupMax);
  const refs = new IndiceRefs(config.refsMax, config.refsTtlMs);
  const entrega = new Entrega({
    coreUrl: config.coreUrl,
    productores: config.productores,
    logger,
  });
  const conectores = new ClienteConectores({
    whatsappUrl: config.whatsappConnectorUrl,
    telegramUrl: config.telegramConnectorUrl,
    secreto: config.connectorSharedSecret,
  });
  const lectura = crearLectura({
    secretos: config.secretosConector,
    conectores,
    jidPropio: () => meCache.getOwnJid(),
    refs,
    logger,
  });
  const bridge = new Bridge(config, meCache, dedup, refs, entrega);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/';
    if (url === '/health' || url === '/healthz') {
      const ready = bridge.isConnected();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'degraded', natsConnected: ready }));
      return;
    }
    if (url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(statusPayload(bridge, meCache, dedup, refs, entrega)));
      return;
    }
    if (url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metricsText(entrega));
      return;
    }
    void lectura(req, res).then(atendida => {
      if (atendida) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no_encontrado', detalle: 'No existe en este conector.' }));
    });
  });
  server.listen(config.port, () => logger.info({ port: config.port }, 'listening'));

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
