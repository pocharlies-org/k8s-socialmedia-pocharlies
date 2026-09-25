/**
 * SC-1227 (SC-1197 P1b): the injected dependencies of the social-api app.
 *
 * Everything the routes and the guards need is decided once, in main.ts, from
 * the env the P3 manifests hand the container (k8s/base/social-pairing.yaml);
 * tests build the same object with a local JWKS and a fake pool. No module
 * below src/api/ reads process.env by itself — the one exception is the
 * account registry (`domain/account-registry.ts`), which keeps its own
 * SOCIAL_ACCOUNTS_FILE + mtime reload so a ConfigMap edit applies without a
 * restart, exactly as it does for the MCP routing that shares the module.
 */
import { Request } from 'express';
import { CredentialStore } from '@mcp-socialmedia/shared';
import { JwtVerifierConfig, VerifiedIdentity } from './auth/keycloak-jwt';
import { WhatsappPairingClient } from './whatsapp-pairing-client';

export interface SocialApiContext {
  /** SOCIAL_PAIRING_API === 'on'. Off: 404 for everything but /health (D7). */
  apiEnabled: boolean;
  /** CREDENTIAL_STORE_ENABLED=true AND a valid CREDENTIAL_STORE_MASTER_KEY. */
  storeAvailable: boolean;
  /**
   * SOCIAL_API_ALLOWED_ORIGINS. Empty by default: a PRESENT Origin header is
   * then always 403 (D5). Requests without any Origin (non-browser in-cluster
   * callers) are unaffected — this is a CSRF gate, not a CORS mechanism, and
   * social-api never answers CORS headers.
   */
  allowedOrigins: string[];
  jwt: JwtVerifierConfig;
  /** Null when the HMAC secret or WHATSAPP_PAIRING_URL is missing → 503. */
  whatsappPairing: WhatsappPairingClient | null;
  /**
   * SC-1228 (P2): READ-ONLY credential store, used by /social/status for the
   * caller's own Instagram row (design D3: `store.get(sub)`). Null when the
   * store is off or the master key is missing — status then reports
   * `unavailable`, it never 503s and never writes: pairing rows are written
   * by the whatsapp-pairing pool only.
   */
  credentialStore: CredentialStore | null;
  /**
   * SC-1228 (P2): SOCIAL_IDENTITY_BINDINGS_FILE — the sub→accounts table,
   * read for the caller's own `sub` only, to build `houseAccounts` (D4).
   */
  identityBindingsPath: string;
  logError: (msg: string) => void;
}

/** A request that passed the JWT guard. Identity is ONLY from the JWT. */
export interface IdentityRequest extends Request {
  identity?: VerifiedIdentity;
}
