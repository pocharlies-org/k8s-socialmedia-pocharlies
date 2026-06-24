/**
 * Strongly-typed, fail-fast configuration for the WhatsApp -> synapse bridge.
 *
 * The bridge is FAIL-CLOSED by design: if a required secret/URL is missing we
 * refuse to start rather than silently forwarding (or silently dropping)
 * traffic. Optional knobs fall back to safe defaults.
 */

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

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireEnv(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return raw.trim();
}

function optionalEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`Environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

/**
 * Build the config from process.env. Throws ConfigError (fail-fast) if any
 * required value is absent. Pure aside from reading process.env, so tests can
 * exercise it by mutating the env then calling it.
 */
export function loadConfig(): BridgeConfig {
  const natsCaCert = optionalEnv('NATS_CA_CERT', '');
  const gatewayWebhookUrl = optionalEnv(
    'GATEWAY_WEBHOOK_URL',
    'https://synapse.e-dani.com/webhooks/whatsapp'
  );
  if (!/^https:\/\//.test(gatewayWebhookUrl)) {
    // Refuse plaintext gateway: the HMAC protects integrity, TLS protects the
    // payload (phone numbers, message bodies) in transit. Fail closed.
    throw new ConfigError(`GATEWAY_WEBHOOK_URL must be https://, got: ${gatewayWebhookUrl}`);
  }

  return {
    natsUrl: optionalEnv('NATS_URL', 'nats://localhost:4222'),
    natsCaCert: natsCaCert && natsCaCert !== 'none' ? natsCaCert : undefined,
    natsQueueGroup: optionalEnv('NATS_QUEUE_GROUP', 'synapse-bridge'),
    gatewayWebhookUrl,
    whatsappWebhookSecret: requireEnv('WHATSAPP_WEBHOOK_SECRET'),
    connectorUrl: optionalEnv(
      'CONNECTOR_URL',
      'http://whatsapp-connector-professional.whatsapp-mcp.svc.cluster.local:3001'
    ),
    connectorSharedSecret: requireEnv('CONNECTOR_SHARED_SECRET'),
    allowedAccount: optionalEnv('ALLOWED_ACCOUNT', 'professional'),
    dedupTtlMs: intEnv('DEDUP_TTL_MS', 86_400_000),
    dedupMax: intEnv('DEDUP_MAX', 50_000),
    meCacheTtlMs: intEnv('ME_CACHE_TTL_MS', 600_000),
    port: intEnv('PORT', 3006),
  };
}

export { ConfigError };
