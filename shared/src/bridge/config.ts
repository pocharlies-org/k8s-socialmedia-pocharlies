/**
 * Fail-fast env helpers of a NATS bridge (DGX-1235 B0, moved from
 * whatsapp-synapse-bridge/src/config.ts): a missing or malformed value throws
 * ConfigError and the bridge refuses to start.
 */

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

function httpUrl(name: string, value: string, httpsOnly = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL`);
  }
  const protocols = httpsOnly ? ['https:'] : ['http:', 'https:'];
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ConfigError(
      `${name} must use ${httpsOnly ? 'HTTPS' : 'HTTP(S)'} without credentials, query or fragment`
    );
  }
  return url.toString().replace(/\/$/, '');
}

function trackingOptInBaseUrl(): string | undefined {
  const value = optionalEnv('TRACKING_OPT_IN_BASE_URL', '');
  return value ? `${httpUrl('TRACKING_OPT_IN_BASE_URL', value)}/` : undefined;
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

export { ConfigError, requireEnv, optionalEnv, httpUrl, trackingOptInBaseUrl, intEnv };
