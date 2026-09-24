/**
 * SC-1225 (SC-1197 P1a): the internal HTTP surface of `whatsapp-pairing`.
 *
 * Only `social-api` calls it (in-cluster, no IngressRoute). It never sees a
 * JWT: social-api verifies the user, derives `sessionKey = sub` and signs the
 * request body with the connector HMAC (api/auth.ts createHMACAuth). Because
 * that HMAC covers the BODY only, every route is a POST carrying
 * `{ "sessionKey": "<sub>" }` — a sessionKey in the path or query would be
 * outside the signature.
 *
 * Gate order, one decision per layer:
 *   1. SOCIAL_PAIRING_API=off  → 404 for everything but GET /health
 *   2. no shared secret        → 503 pairing_unavailable (cannot verify)
 *   3. bad/missing HMAC        → 401
 *   4. store off / no key      → 503 pairing_unavailable
 *   5. malformed sessionKey    → 400 invalid_session_key
 *   6. limits                  → 429 + Retry-After
 */
import express, { NextFunction, Request, Response } from 'express';
import { credentialMasterKeyFromEnv, credentialStoreEnabled } from '@mcp-socialmedia/shared';
import { createHMACAuth } from '../api/auth';
import { InvalidSessionKeyError, PairingMe, PairingStatus, PoolLimitError } from './session-pool';

/** What the routes need from SessionPool (a structural seam for the specs). */
export interface PairingPoolApi {
  start(sessionKey: string): Promise<PairingStatus>;
  status(sessionKey: string): Promise<PairingStatus>;
  me(sessionKey: string): Promise<PairingMe | null>;
  size(): number;
}

export interface PairingAppOptions {
  /** SOCIAL_PAIRING_API === 'on'. */
  apiEnabled: boolean;
  /** CREDENTIAL_STORE_ENABLED=true AND a valid CREDENTIAL_STORE_MASTER_KEY. */
  storeAvailable: boolean;
  /** CONNECTOR_SHARED_SECRET; null = cannot authenticate → 503. */
  sharedSecret: string | null;
  /** Null when the store is unavailable (never constructed). */
  pool: PairingPoolApi | null;
  logError?: (msg: string) => void;
}

// CONTRACT: http.whatsapp-pairing.internal-sessions.v1
export const INTERNAL_SESSIONS_BASE = '/internal/whatsapp/sessions';

export function pairingApiEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SOCIAL_PAIRING_API || 'off').trim().toLowerCase() === 'on';
}

/** Store usable = flag on AND a parseable master key (fail closed on a bad key). */
export function pairingStoreAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!credentialStoreEnabled(env)) return false;
  try {
    return credentialMasterKeyFromEnv(env) !== null;
  } catch (e) {
    console.error(`pairing: CREDENTIAL_STORE_MASTER_KEY rejected: ${(e as Error).message}`);
    return false;
  }
}

export function createPairingApp(opts: PairingAppOptions): express.Express {
  const logError = opts.logError || (msg => console.error(msg));
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      pairingApi: opts.apiEnabled ? 'on' : 'off',
      store: opts.storeAvailable ? 'available' : 'unavailable',
      sessions: opts.pool ? opts.pool.size() : 0,
    });
  });

  if (!opts.apiEnabled) {
    app.use((_req, res) => {
      res.status(404).json({ error: 'not_found' });
    });
    return app;
  }

  const unavailable = (res: Response): void => {
    res.status(503).json({ error: 'pairing_unavailable' });
  };

  const router = express.Router();
  router.use(express.json({ limit: '4kb' }));
  const hmac = opts.sharedSecret ? createHMACAuth(opts.sharedSecret) : null;
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!hmac) return unavailable(res);
    hmac(req, res, next);
  });
  router.use((_req: Request, res: Response, next: NextFunction) => {
    if (!opts.storeAvailable || !opts.pool) return unavailable(res);
    next();
  });

  const handle =
    (fn: (pool: PairingPoolApi, sessionKey: string, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      const sessionKey = (req.body as { sessionKey?: unknown } | undefined)?.sessionKey;
      try {
        if (typeof sessionKey !== 'string') throw new InvalidSessionKeyError();
        await fn(opts.pool as PairingPoolApi, sessionKey, res);
      } catch (e) {
        if (e instanceof InvalidSessionKeyError) {
          res.status(400).json({ error: 'invalid_session_key' });
          return;
        }
        if (e instanceof PoolLimitError) {
          res.setHeader('Retry-After', String(e.retryAfterSeconds));
          res.status(429).json({
            error: 'rate_limited',
            reason: e.reason,
            retryAfterSeconds: e.retryAfterSeconds,
          });
          return;
        }
        logError(`pairing: ${req.path} failed: ${(e as Error)?.message || e}`);
        res.status(500).json({ error: 'internal_error' });
      }
    };

  // CONTRACT: http.whatsapp-pairing.internal-sessions.v1 — POST /start
  router.post(
    '/start',
    handle(async (pool, sessionKey, res) => {
      res.json(await pool.start(sessionKey));
    })
  );

  // CONTRACT: http.whatsapp-pairing.internal-sessions.v1 — POST /state
  router.post(
    '/state',
    handle(async (pool, sessionKey, res) => {
      res.json(await pool.status(sessionKey));
    })
  );

  // CONTRACT: http.whatsapp-pairing.internal-sessions.v1 — POST /me
  router.post(
    '/me',
    handle(async (pool, sessionKey, res) => {
      const me = await pool.me(sessionKey);
      if (!me) {
        res.status(404).json({ error: 'not_paired' });
        return;
      }
      res.json({ sessionKey, me });
    })
  );

  app.use(INTERNAL_SESSIONS_BASE, router);
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  return app;
}
