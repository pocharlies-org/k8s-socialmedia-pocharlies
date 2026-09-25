/**
 * SC-1227 (SC-1197 P1b): the env reading of social-api, kept out of main.ts
 * so it is testable without starting a server. The env names are the contract
 * with the P3 manifests (k8s/base/social-pairing.yaml, branch sc1197-p3-k8s):
 * SOCIAL_PAIRING_API, SOCIAL_API_ALLOWED_ORIGINS, SOCIAL_API_JWT_ISSUER,
 * SOCIAL_API_JWKS_URL, SOCIAL_API_JWT_AUDIENCE, SOCIAL_API_ALLOWED_AZP,
 * SOCIAL_API_JWT_CLOCK_TOLERANCE_SECONDS (read in api/auth/keycloak-jwt.ts,
 * default 30 s), WHATSAPP_PAIRING_URL, TELEGRAM_PAIRING_URL (reserved for
 * P4b, unused here),
 * CONNECTOR_SHARED_SECRET, CREDENTIAL_STORE_ENABLED, CREDENTIAL_STORE_MASTER_KEY,
 * DATABASE_URL and SOCIAL_IDENTITY_BINDINGS_FILE (both read only by the
 * /social/status store and bindings wiring added in SC-1228).
 */
import { Pool } from 'pg';
import {
  credentialMasterKeyFromEnv,
  CredentialStore,
  credentialStoreEnabled,
  PostgresCredentialStore,
} from '@mcp-socialmedia/shared';
import { jwtVerifierConfigFromEnv } from '../api/auth/keycloak-jwt';
import { SocialApiContext } from '../api/context';
import { WhatsappPairingClient } from '../api/whatsapp-pairing-client';
import { identityBindingsFile } from '../domain/identity-bindings';

/** SOCIAL_PAIRING_API === 'on'. Same reading as the pool (pairing/app.ts). */
export function pairingApiEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SOCIAL_PAIRING_API || 'off').trim().toLowerCase() === 'on';
}

/**
 * Store usable = flag on AND a parseable master key (fail closed on a bad
 * key) — the same gate the pool applies, so social-api answers 503 before
 * signing a call the pool would refuse anyway (design D7).
 */
export function pairingStoreAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!credentialStoreEnabled(env)) return false;
  try {
    return credentialMasterKeyFromEnv(env) !== null;
  } catch (e) {
    console.error(`social-api: CREDENTIAL_STORE_MASTER_KEY rejected: ${(e as Error).message}`);
    return false;
  }
}

/** Same default the rest of mcp-server uses for a missing DATABASE_URL. */
const DEFAULT_DATABASE_URL = 'postgresql://whatsappmcp:whatsappmcp_dev@localhost:5432/whatsappmcp';

/**
 * SC-1228 (design D3): the read-only store /social/status uses for the
 * caller's own Instagram row. A pg Pool connects lazily, so constructing it
 * costs nothing and social-api still boots with the DB down — a failed read
 * is an `unavailable` state, not a crash and not a 503. Never written here:
 * the whatsapp-pairing pool is the only writer of credential rows.
 */
export function statusCredentialStore(
  env: NodeJS.ProcessEnv,
  storeAvailable: boolean
): CredentialStore | null {
  if (!storeAvailable) return null;
  return new PostgresCredentialStore(
    new Pool({
      connectionString: (env.DATABASE_URL || DEFAULT_DATABASE_URL).trim(),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      application_name: 'social-api-status',
    })
  );
}

function originsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return (env.SOCIAL_API_ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): SocialApiContext {
  const apiEnabled = pairingApiEnabledFromEnv(env);
  const storeAvailable = apiEnabled && pairingStoreAvailable(env);
  const sharedSecret = (env.CONNECTOR_SHARED_SECRET || '').trim();
  const pairingUrl = (env.WHATSAPP_PAIRING_URL || '').trim();
  const pairing =
    apiEnabled && sharedSecret && pairingUrl
      ? new WhatsappPairingClient(pairingUrl, sharedSecret)
      : null;
  return {
    apiEnabled,
    storeAvailable,
    allowedOrigins: originsFromEnv(env),
    jwt: jwtVerifierConfigFromEnv(env),
    whatsappPairing: pairing,
    credentialStore: statusCredentialStore(env, storeAvailable),
    identityBindingsPath: identityBindingsFile(env),
    logError: msg => console.error(msg),
  };
}
