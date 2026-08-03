/** Fail-fast configuration for the Skirmshop Instagram DM → Synapse bridge. */

export interface BridgeConfig {
  natsUrl: string;
  natsCaCert?: string;
  synapseWebhookUrl: string;
  instagramWebhookSecret: string;
  durableName: string;
  port: number;
  ackWaitMs: number;
  retryDelayMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = optionalEnv(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`Environment variable ${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): BridgeConfig {
  const synapseWebhookUrl = optionalEnv(
    'SYNAPSE_INSTAGRAM_WEBHOOK_URL',
    'https://synapse.e-dani.com/webhooks/instagram'
  );
  if (!synapseWebhookUrl.startsWith('https://')) {
    throw new ConfigError('SYNAPSE_INSTAGRAM_WEBHOOK_URL must use https://');
  }

  const durableName = optionalEnv('INSTAGRAM_DM_DURABLE', 'synapse-instagram-skirmshop-v1');
  if (!/^[A-Za-z0-9_-]+$/.test(durableName)) {
    throw new ConfigError('INSTAGRAM_DM_DURABLE contains unsupported characters');
  }

  const natsCaCert = optionalEnv('NATS_CA_CERT', '');
  return {
    natsUrl: optionalEnv('NATS_URL', 'nats://localhost:4222'),
    natsCaCert: natsCaCert && natsCaCert !== 'none' ? natsCaCert : undefined,
    synapseWebhookUrl,
    // Deliberately distinct from the Meta app secret and connector internal token.
    instagramWebhookSecret: requireEnv('INSTAGRAM_WEBHOOK_SECRET'),
    durableName,
    port: positiveInteger('PORT', 3007),
    ackWaitMs: positiveInteger('INSTAGRAM_DM_ACK_WAIT_MS', 30_000),
    retryDelayMs: positiveInteger('INSTAGRAM_DM_RETRY_DELAY_MS', 5_000),
  };
}
