/**
 * SC-1227 (SC-1197 P1b): the env reading of social-api, kept out of main.ts
 * so it is testable without starting a server. The env names are the contract
 * with the P3 manifests (k8s/base/social-pairing.yaml, branch sc1197-p3-k8s):
 * SOCIAL_PAIRING_API, SOCIAL_API_ALLOWED_ORIGINS, SOCIAL_API_JWT_ISSUER,
 * SOCIAL_API_JWKS_URL, SOCIAL_API_JWT_AUDIENCE, SOCIAL_API_ALLOWED_AZP,
 * SOCIAL_API_JWT_CLOCK_TOLERANCE_SECONDS (read in api/auth/keycloak-jwt.ts,
 * default 30 s), WHATSAPP_PAIRING_URL, TELEGRAM_PAIRING_URL (reserved for
 * P4b, unused here),
 * CONNECTOR_SHARED_SECRET, CREDENTIAL_STORE_ENABLED, CREDENTIAL_STORE_MASTER_KEY.
 */
import { credentialMasterKeyFromEnv, credentialStoreEnabled } from '@mcp-socialmedia/shared';
import { jwtVerifierConfigFromEnv } from '../api/auth/keycloak-jwt';
import { SocialApiContext } from '../api/context';
import { WhatsappPairingClient } from '../api/whatsapp-pairing-client';

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
    logError: msg => console.error(msg),
  };
}
