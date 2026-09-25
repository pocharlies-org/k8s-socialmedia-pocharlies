/**
 * SC-1227 (SC-1197 P1b): the hardening guards in front of every authed
 * social-api route (design D5). One decision per guard, in this order:
 *
 *   originGuard  a PRESENT Origin header outside SOCIAL_API_ALLOWED_ORIGINS
 *                (empty by default) is 403. social-api never answers CORS
 *                headers: it is in-cluster only (no IngressRoute), the Origin
 *                gate is defense against a browser-driven request, not a
 *                cross-origin enabler.
 *   jwtGuard     identity comes ONLY from the verified JWT (never x-user-sub).
 *                401 with WWW-Authenticate: Bearer; 503 if the JWKS endpoint
 *                cannot be reached. A rejected request never reaches the pool.
 *   identityGuard  `sub`, `sessionKey` or `jid` present in the query or the
 *                body with a value different from the JWT `sub` is 403 — the
 *                cross-sub attempt this whole story exists to stop. A value
 *                equal to the caller's own sub is accepted and ignored; the
 *                sessionKey sent to the pool is always the JWT sub.
 *   storeGate    credential store off / no master key / no HMAC secret or pool
 *                URL → 503 pairing_unavailable (D7): the pool is the only
 *                writer of credential rows, and without it nothing works.
 */
import { NextFunction, Response } from 'express';
import { JwtAuthError, verifyKeycloakJwt } from './auth/keycloak-jwt';
import { IdentityRequest, SocialApiContext } from './context';

const IDENTITY_FIELDS = ['sub', 'sessionKey', 'jid'] as const;

export function originGuard(ctx: SocialApiContext) {
  return (req: IdentityRequest, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin !== undefined && !ctx.allowedOrigins.includes(origin)) {
      ctx.logError(`social-api: rejected Origin ${origin}`);
      res.status(403).json({ error: 'forbidden_origin' });
      return;
    }
    next();
  };
}

export function jwtGuard(ctx: SocialApiContext) {
  return async (req: IdentityRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.identity = await verifyKeycloakJwt(req.headers.authorization, ctx.jwt);
      next();
    } catch (err) {
      if (err instanceof JwtAuthError) {
        if (err.wwwAuthenticate) res.setHeader('WWW-Authenticate', err.wwwAuthenticate);
        res.status(err.status).json({
          error: err.status === 401 ? 'unauthorized' : 'identity_unavailable',
        });
        if (err.status === 503) ctx.logError(`social-api: JWKS unreachable: ${err.message}`);
        return;
      }
      ctx.logError(`social-api: unexpected JWT guard error: ${(err as Error)?.message || err}`);
      res.status(401).json({ error: 'unauthorized' });
    }
  };
}

/** A field value is acceptable only if it is the caller's own sub, verbatim. */
function foreignIdentity(value: unknown, sub: string): boolean {
  return value !== undefined && (typeof value !== 'string' || value !== sub);
}

export function identityGuard(ctx: SocialApiContext) {
  return (req: IdentityRequest, res: Response, next: NextFunction): void => {
    const sub = req.identity?.sub;
    if (!sub) {
      // unreachable: jwtGuard runs first and sets identity before next()
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body: unknown = req.body;
    const bodyObject =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : undefined;
    for (const field of IDENTITY_FIELDS) {
      const fromQuery = (req.query as Record<string, unknown>)[field];
      const fromBody = bodyObject?.[field];
      if (foreignIdentity(fromQuery, sub) || foreignIdentity(fromBody, sub)) {
        ctx.logError(`social-api: rejected foreign ${field} in ${req.path}`);
        res.status(403).json({ error: 'forbidden_identity' });
        return;
      }
    }
    next();
  };
}

export function storeGate(ctx: SocialApiContext) {
  return (req: IdentityRequest, res: Response, next: NextFunction): void => {
    if (!ctx.storeAvailable || !ctx.whatsappPairing) {
      res.status(503).json({ error: 'pairing_unavailable' });
      return;
    }
    next();
  };
}
