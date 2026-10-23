/**
 * Strongly-typed, fail-fast configuration for the WhatsApp -> synapse bridge.
 *
 * The bridge is FAIL-CLOSED by design: if a required secret/URL is missing we
 * refuse to start rather than silently forwarding (or silently dropping)
 * traffic. Optional knobs fall back to safe defaults.
 */

import { ConfigError, requireEnv, optionalEnv, httpUrl, trackingOptInBaseUrl, intEnv } from '@mcp-socialmedia/shared';

export interface BridgeConfig {
  /** NATS server URL (e.g. nats://whatsapp-mcp-nats...:4222). */
  natsUrl: string;
  /** Optional CA cert path for tls:// NATS. 'none'/empty => plaintext. */
  natsCaCert?: string;
  /** Queue group: all bridge replicas share one queue (at-most-once delivery). */
  natsQueueGroup: string;
  /** synapse-gateway webhook endpoint (https). */
  gatewayWebhookUrl: string;
  /** Shared secret for the gateway HMAC (base64 sig over the exact bytes). */
  whatsappWebhookSecret: string;
  /** Base URL of the professional WhatsApp connector (for GET /api/v1/me). */
  connectorUrl: string;
  /** Shared secret for the connector HMAC scheme (X-Connector-Signature). */
  connectorSharedSecret: string;
  /** Only this account is ever forwarded. */
  allowedAccount: string;
  /** Dedup entry TTL in ms. */
  dedupTtlMs: number;
  /** Dedup max entries before oldest are evicted. */
  dedupMax: number;
  /** /me (own-JID) cache TTL in ms. */
  meCacheTtlMs: number;
  /** Health/status HTTP port. */
  port: number;
}

/**
 * Build the config from process.env. Throws ConfigError (fail-fast) if any
 * required value is absent. Pure aside from reading process.env, so tests can
 * exercise it by mutating the env then calling it.
 */
export function loadConfig(): BridgeConfig {
  const natsCaCert = optionalEnv('NATS_CA_CERT', '');
  const gatewayWebhookUrl = httpUrl('GATEWAY_WEBHOOK_URL', requireEnv('GATEWAY_WEBHOOK_URL'), true);
  const connectorUrl = httpUrl('CONNECTOR_URL', requireEnv('CONNECTOR_URL'));
  trackingOptInBaseUrl();

  return {
    natsUrl: optionalEnv('NATS_URL', 'nats://localhost:4222'),
    natsCaCert: natsCaCert && natsCaCert !== 'none' ? natsCaCert : undefined,
    natsQueueGroup: optionalEnv('NATS_QUEUE_GROUP', 'synapse-bridge'),
    gatewayWebhookUrl,
    whatsappWebhookSecret: requireEnv('WHATSAPP_WEBHOOK_SECRET'),
    connectorUrl,
    connectorSharedSecret: requireEnv('CONNECTOR_SHARED_SECRET'),
    allowedAccount: optionalEnv('ALLOWED_ACCOUNT', 'professional'),
    dedupTtlMs: intEnv('DEDUP_TTL_MS', 86_400_000),
    dedupMax: intEnv('DEDUP_MAX', 50_000),
    meCacheTtlMs: intEnv('ME_CACHE_TTL_MS', 600_000),
    port: intEnv('PORT', 3006),
  };
}

export { ConfigError, trackingOptInBaseUrl };
