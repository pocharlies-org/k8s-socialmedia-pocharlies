/**
 * SC-1227 (SC-1197 P1b): the JWT verifier of `social-api` (design D2).
 *
 * `social-api` is the ONLY place in this repo that verifies a user token. The
 * identity of every request is the `sub` claim of a Keycloak access token
 * from the `edani` realm, nothing else: this module never reads `x-user-sub`
 * or any other header-carried identity — that header is forgeable in-cluster
 * (SC-1144 risk note) and is not an authentication input here.
 *
 * Verification parameters (defaults, all overridable by env):
 *   iss   https://auth-next.e-dani.com/realms/edani  (SOCIAL_API_JWT_ISSUER)
 *   jwks  in-cluster Keycloak certs endpoint         (SOCIAL_API_JWKS_URL)
 *   aud   must CONTAIN 'social-api'                  (SOCIAL_API_JWT_AUDIENCE)
 *   azp   must be in the allowlist                   (SOCIAL_API_ALLOWED_AZP)
 *   alg   RS256 only, typ=Bearer, clockTolerance 30 s
 *
 * `createRemoteJWKSet` lives at module level (one cache per JWKS URL, never
 * rebuilt per request): cooldownDuration 30 s and cacheMaxAge 10 min — the
 * spec's "cooldown 30 s, caché 10 min", which are also jose's own defaults.
 *
 * Outcomes: a bad/expired/foreign token is 401 with `WWW-Authenticate:
 * Bearer`; a JWKS endpoint that cannot be reached is 503 (fail closed —
 * design D2 "se deniega").
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';

// CONTRACT: http.social-api.jwt-audience.v1
export const DEFAULT_JWT_ISSUER = 'https://auth-next.e-dani.com/realms/edani';
export const DEFAULT_JWKS_URL =
  'http://keycloak.keycloak.svc.cluster.local/realms/edani/protocol/openid-connect/certs';
// CONTRACT: http.social-api.jwt-audience.v1 — the audience claim value. Adding
// a second audience is additive; changing or removing this string is breaking.
export const DEFAULT_JWT_AUDIENCE = 'social-api';
export const DEFAULT_ALLOWED_AZP = 'dgx-messages';

const JWKS_COOLDOWN_MS = 30_000; // no new HTTP request for 30 s after a good fetch
const JWKS_CACHE_MAX_AGE_MS = 600_000; // refetch once the cache is 10 min old
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30;
const EXPECTED_TYP = 'Bearer';

export interface JwtVerifierConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
  allowedAzp: string[];
  clockToleranceSeconds: number;
}

/** Env wiring per the P3 manifests (k8s/base/social-pairing.yaml), spec point 7. */
export function jwtVerifierConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JwtVerifierConfig {
  return {
    issuer: env.SOCIAL_API_JWT_ISSUER?.trim() || DEFAULT_JWT_ISSUER,
    jwksUrl: env.SOCIAL_API_JWKS_URL?.trim() || DEFAULT_JWKS_URL,
    audience: env.SOCIAL_API_JWT_AUDIENCE?.trim() || DEFAULT_JWT_AUDIENCE,
    allowedAzp: splitList(env.SOCIAL_API_ALLOWED_AZP, DEFAULT_ALLOWED_AZP),
    clockToleranceSeconds:
      parseInt(env.SOCIAL_API_JWT_CLOCK_TOLERANCE_SECONDS || '', 10) > 0
        ? parseInt(env.SOCIAL_API_JWT_CLOCK_TOLERANCE_SECONDS as string, 10)
        : DEFAULT_CLOCK_TOLERANCE_SECONDS,
  };
}

function splitList(value: string | undefined, fallback: string): string[] {
  const raw = value === undefined || value === null ? fallback : value;
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Module-level remote JWK sets, one per URL (design D2). jose refetches only
 * when the cache is older than cacheMaxAge or a kid misses and the cooldown
 * has elapsed; tests that point at a different URL get their own set.
 */
const remoteSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function remoteJwkSet(url: string): ReturnType<typeof createRemoteJWKSet> {
  let set = remoteSets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), {
      cooldownDuration: JWKS_COOLDOWN_MS,
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    });
    remoteSets.set(url, set);
  }
  return set;
}

export class JwtAuthError extends Error {
  constructor(
    readonly status: 401 | 503,
    message: string,
    readonly wwwAuthenticate?: string
  ) {
    super(message);
    this.name = 'JwtAuthError';
  }
}

export interface VerifiedIdentity {
  /** The Keycloak `sub` — the sessionKey of every pairing operation. */
  sub: string;
  azp: string | null;
}

/** Errors that mean "this token is not acceptable" (401), not "cannot check" (503). */
const TOKEN_PROBLEM_ERRORS: Array<new (...args: never[]) => Error> = [
  joseErrors.JWTClaimValidationFailed,
  joseErrors.JWTExpired,
  joseErrors.JWSInvalid,
  joseErrors.JWTInvalid,
  joseErrors.JWSSignatureVerificationFailed,
  joseErrors.JWKSNoMatchingKey,
  joseErrors.JOSEAlgNotAllowed,
];

function isTokenProblem(err: unknown): boolean {
  return TOKEN_PROBLEM_ERRORS.some(Err => err instanceof Err);
}

/**
 * Verify an `Authorization: Bearer <jwt>` value. Returns the identity or
 * throws JwtAuthError(401|503). Never consults headers other than
 * Authorization — in particular x-user-sub is not an input (SC-1144).
 */
export async function verifyKeycloakJwt(
  authorizationHeader: string | undefined,
  cfg: JwtVerifierConfig
): Promise<VerifiedIdentity> {
  if (!authorizationHeader) {
    throw new JwtAuthError(401, 'missing bearer token', 'Bearer');
  }
  const space = authorizationHeader.indexOf(' ');
  const scheme = authorizationHeader.slice(0, space);
  const token = authorizationHeader.slice(space + 1).trim();
  if (space < 0 || scheme.toLowerCase() !== 'bearer' || !token) {
    throw new JwtAuthError(401, 'not a bearer token', 'Bearer error="invalid_token"');
  }

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload } = await jwtVerify(token, remoteJwkSet(cfg.jwksUrl), {
      issuer: cfg.issuer,
      audience: cfg.audience,
      typ: EXPECTED_TYP,
      clockTolerance: cfg.clockToleranceSeconds,
      algorithms: ['RS256'],
    }));
  } catch (err) {
    if (isTokenProblem(err)) {
      throw new JwtAuthError(401, 'invalid token', 'Bearer error="invalid_token"');
    }
    // fetch failure, timeout, non-200, unparsable JWKS...: cannot verify → deny (D2)
    throw new JwtAuthError(503, 'identity provider unreachable');
  }

  const azp = typeof payload.azp === 'string' ? payload.azp : null;
  if (!azp || !cfg.allowedAzp.includes(azp)) {
    throw new JwtAuthError(401, 'azp not allowed', 'Bearer error="invalid_token"');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new JwtAuthError(401, 'token has no subject', 'Bearer error="invalid_token"');
  }
  return { sub: payload.sub, azp };
}
