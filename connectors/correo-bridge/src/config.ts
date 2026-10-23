/**
 * Fail-fast configuration of correo-bridge (DGX-1235), on the helpers of
 * shared/src/bridge. A missing key or URL refuses to start.
 *
 * Three kinds of key, never the same value (security condition 4 of DGX-1210):
 * - one producer key per connector (correo-core docs/guia-modulos.md: a producer
 *   per connector, `ingest:mensajes`, `conectores: [<id>]`): signs POST /v2/mensajes;
 * - one key per connector (`wa-*`, `tg-*`): the core signs its reads with it;
 * - CONNECTOR_SHARED_SECRET: the house HMAC towards the socialmedia connectors.
 */

import { ConfigError, requireEnv, optionalEnv, httpUrl, intEnv, trackingOptInBaseUrl } from '@mcp-socialmedia/shared';

export type Canal = 'whatsapp' | 'telegram';

export interface BridgeConfig {
  natsUrl: string;
  natsCaCert?: string;
  /** Own queue group: never `synapse-bridge`, or each bridge would get half the messages. */
  natsQueueGroup: string;
  whatsappConnectorUrl: string;
  telegramConnectorUrl: string;
  connectorSharedSecret: string;
  /** Machine server of the correo core (no path). */
  coreUrl: string;
  /** Connector id -> its producer (id and key) towards the core. */
  productores: Map<string, { id: string; secreto: string }>;
  /** Connector id -> its key, for verifying the core's reads. */
  secretosConector: Map<string, string>;
  conectorPorCanal: Record<Canal, string>;
  /** POST /envios answers 403 envio_desactivado unless ENABLE_OUTBOUND is exactly `true` (B2). */
  enableOutbound: boolean;
  dedupTtlMs: number;
  dedupMax: number;
  meCacheTtlMs: number;
  refsMax: number;
  refsTtlMs: number;
  port: number;
}

function patron(name: string, re: RegExp): string {
  const value = requireEnv(name);
  if (!re.test(value)) throw new ConfigError(`${name} must match ${re}`);
  return value;
}

function clave(name: string): string {
  const value = requireEnv(name);
  if (value.length < 32) throw new ConfigError(`${name} must be at least 32 characters`);
  return value;
}

export function loadConfig(): BridgeConfig {
  const natsCaCert = optionalEnv('NATS_CA_CERT', '');
  const natsQueueGroup = optionalEnv('NATS_QUEUE_GROUP', 'correo-bridge');
  if (natsQueueGroup === 'synapse-bridge') {
    throw new ConfigError('NATS_QUEUE_GROUP must not be synapse-bridge');
  }
  const whatsappConnectorUrl = httpUrl('WA_CONNECTOR_URL', requireEnv('WA_CONNECTOR_URL'));
  const telegramConnectorUrl = httpUrl('TG_CONNECTOR_URL', requireEnv('TG_CONNECTOR_URL'));
  const connectorSharedSecret = requireEnv('CONNECTOR_SHARED_SECRET');
  const coreUrl = httpUrl('CORE_URL', requireEnv('CORE_URL'));
  if (new URL(coreUrl).pathname !== '/') throw new ConfigError('CORE_URL must have no path');
  const productorWa = patron('CORREO_PRODUCTOR_WA_ID', /^[a-z0-9][a-z0-9-]{0,39}$/);
  const productorWaSecreto = clave('CORREO_PRODUCTOR_WA_SECRET');
  const productorTg = patron('CORREO_PRODUCTOR_TG_ID', /^[a-z0-9][a-z0-9-]{0,39}$/);
  const productorTgSecreto = clave('CORREO_PRODUCTOR_TG_SECRET');
  if (productorWa === productorTg) throw new ConfigError('CORREO_PRODUCTOR_TG_ID must differ from CORREO_PRODUCTOR_WA_ID');
  const waId = patron('CORREO_CONECTOR_WA_ID', /^wa-[a-z0-9-]{1,40}$/);
  const waSecreto = clave('CORREO_CONECTOR_WA_SECRET');
  const tgId = patron('CORREO_CONECTOR_TG_ID', /^tg-[a-z0-9-]{1,40}$/);
  const tgSecreto = clave('CORREO_CONECTOR_TG_SECRET');
  trackingOptInBaseUrl();
  const enableOutbound = optionalEnv('ENABLE_OUTBOUND', 'false');
  if (enableOutbound !== 'true' && enableOutbound !== 'false') {
    throw new ConfigError('ENABLE_OUTBOUND must be true or false');
  }

  const todas = [productorWaSecreto, productorTgSecreto, waSecreto, tgSecreto, connectorSharedSecret];
  if (new Set(todas).size !== todas.length) {
    throw new ConfigError('each producer key, each connector key and CONNECTOR_SHARED_SECRET must be distinct');
  }

  return {
    natsUrl: optionalEnv('NATS_URL', 'nats://localhost:4222'),
    natsCaCert: natsCaCert && natsCaCert !== 'none' ? natsCaCert : undefined,
    natsQueueGroup,
    whatsappConnectorUrl,
    telegramConnectorUrl,
    connectorSharedSecret,
    coreUrl,
    productores: new Map([[waId, { id: productorWa, secreto: productorWaSecreto }], [tgId, { id: productorTg, secreto: productorTgSecreto }]]),
    secretosConector: new Map([[waId, waSecreto], [tgId, tgSecreto]]),
    conectorPorCanal: { whatsapp: waId, telegram: tgId },
    enableOutbound: enableOutbound === 'true',
    dedupTtlMs: intEnv('DEDUP_TTL_MS', 86_400_000),
    dedupMax: intEnv('DEDUP_MAX', 50_000),
    meCacheTtlMs: intEnv('ME_CACHE_TTL_MS', 600_000),
    refsMax: intEnv('REFS_MAX', 50_000),
    refsTtlMs: intEnv('REFS_TTL_MS', 30 * 86_400_000),
    port: intEnv('PORT', 8080),
  };
}

export { ConfigError };
