/**
 * SC-1229 (SC-1197 P4b): the internal HTTP surface of `telegram-pairing` —
 * the Telegram twin of connectors/whatsapp-web/src/pairing/app.ts (P1a).
 *
 * Only `social-api` calls it (in-cluster, no IngressRoute). It never sees a
 * JWT: social-api verifies the user, derives `sessionKey = sub` and signs the
 * request body with the connector HMAC (same scheme the house connector
 * verifies in src/api/controller.ts, via shared's verifyHMACSignature).
 * Because the HMAC covers the BODY only, every route is a POST carrying
 * `{ "sessionKey": "<sub>" }` — a sessionKey in the path or query would be
 * outside the signature. /password adds `password` to that signed body.
 *
 * Gate order, one decision per layer (identical to the whatsapp pool):
 *   1. SOCIAL_PAIRING_API=off  → 404 for everything but GET /health
 *   2. no shared secret        → 503 pairing_unavailable (cannot verify)
 *   3. bad/missing HMAC        → 401
 *   4. store off / no key      → 503 pairing_unavailable
 *   5. malformed sessionKey    → 400 invalid_session_key
 *   6. limits                  → 429 + Retry-After
 *   7. /password outside the password state → 409 password_not_requested
 *
 * The env this process reads is EXACTLY telegramPairingConfigFromEnv below:
 * the house sessions (TELEGRAM_SESSION_STRING*) are not part of it and are
 * never read (app.test.ts pins both facts).
 */
import express, { NextFunction, Request, Response } from 'express';
import {
  credentialMasterKeyFromEnv,
  credentialStoreEnabled,
  verifyHMACSignature,
} from '@mcp-socialmedia/shared';
import {
  InvalidPasswordError,
  InvalidSessionKeyError,
  NotAwaitingPasswordError,
  PoolLimitError,
  TelegramPairingMe,
  TelegramPairingStatus,
} from './session-pool';

/** What the routes need from TelegramSessionPool (a structural seam for the specs). */
export interface TelegramPairingPoolApi {
  start(sessionKey: string): Promise<TelegramPairingStatus>;
  status(sessionKey: string): Promise<TelegramPairingStatus>;
  me(sessionKey: string): Promise<TelegramPairingMe | null>;
  submitPassword(sessionKey: string, password: string): Promise<TelegramPairingStatus>;
  size(): number;
}

// CONTRACT: http.telegram-pairing.internal-sessions.v1
export const INTERNAL_TELEGRAM_SESSIONS_BASE = '/internal/telegram/sessions';

/** SOCIAL_PAIRING_API === 'on'. Same reading as the whatsapp pool and social-api. */
export function pairingApiEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SOCIAL_PAIRING_API || 'off').trim().toLowerCase() === 'on';
}

/** Store usable = flag on AND a parseable master key (fail closed on a bad key). */
export function pairingStoreAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!credentialStoreEnabled(env)) return false;
  try {
    return credentialMasterKeyFromEnv(env) !== null;
  } catch (e) {
    console.error(
      `telegram-pairing: CREDENTIAL_STORE_MASTER_KEY rejected: ${(e as Error).message}`
    );
    return false;
  }
}

/** Upper bound accepted for a 2FA password (Telegram's own limit is far below). */
export const MAX_PASSWORD_LENGTH = 1024;

export interface TelegramPairingConfig {
  apiEnabled: boolean;
  storeAvailable: boolean;
  sharedSecret: string | null;
  /** 0 = TELEGRAM_API_ID missing/unparseable → the pool cannot be built. */
  apiId: number;
  apiHash: string | null;
  port: number;
}

/**
 * The whole env contract of this process, in one testable place: the 8
 * variables the P3 manifest hands the pod (PORT, SOCIAL_PAIRING_API,
 * SESSION_PATH — unused, the mtcute state is memory-only —,
 * CONNECTOR_SHARED_SECRET, DB_USER, DB_PASSWORD, CREDENTIAL_STORE_MASTER_KEY,
 * DATABASE_URL — the last three consumed by db-pool/store) plus
 * TELEGRAM_API_ID and TELEGRAM_API_HASH. It reads NO session string: the
 * house accounts' TELEGRAM_SESSION_STRING* must never reach a per-sub pool
 * (SC-1229 spec; pinned by app.test.ts).
 */
export function telegramPairingConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): TelegramPairingConfig {
  const apiEnabled = pairingApiEnabledFromEnv(env);
  const apiIdRaw = (env.TELEGRAM_API_ID || '').trim();
  const apiId = /^\d+$/.test(apiIdRaw) ? parseInt(apiIdRaw, 10) : 0;
  return {
    apiEnabled,
    storeAvailable: apiEnabled && pairingStoreAvailable(env),
    sharedSecret: (env.CONNECTOR_SHARED_SECRET || '').trim() || null,
    apiId,
    apiHash: (env.TELEGRAM_API_HASH || '').trim() || null,
    port: parseInt(env.PORT || '3002', 10) || 3002,
  };
}

export interface TelegramPairingAppOptions {
  /** SOCIAL_PAIRING_API === 'on'. */
  apiEnabled: boolean;
  /** CREDENTIAL_STORE_ENABLED=true AND a valid CREDENTIAL_STORE_MASTER_KEY. */
  storeAvailable: boolean;
  /** CONNECTOR_SHARED_SECRET; null = cannot verify → 503. */
  sharedSecret: string | null;
  /** Null when the store is unavailable or the API credentials are missing. */
  pool: TelegramPairingPoolApi | null;
  logError?: (msg: string) => void;
}

/**
 * Verify the connector HMAC with shared's verifyHMACSignature — the same
 * scheme the house middleware enforces (api/controller.ts authMiddleware /
 * whatsapp createHMACAuth): sha256=HMAC(secret, "<ts>:<JSON body>"), 5-minute
 * window, constant-time comparison, over the PARSED body — the sessionKey
 * (and the password) travel inside the signature (SC-1229 round 2: this was
 * a third copy of that logic, comparing with !==).
 */
function hmacMiddleware(sharedSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const signature = req.headers['x-connector-signature'] as string | undefined;
    const timestamp = req.headers['x-connector-timestamp'] as string | undefined;
    if (!signature || !timestamp) {
      res.status(401).json({ error: 'Missing authentication headers' });
      return;
    }
    if (!verifyHMACSignature(req.body ?? {}, parseInt(timestamp, 10), signature, sharedSecret)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
    next();
  };
}

export function createTelegramPairingApp(opts: TelegramPairingAppOptions): express.Express {
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
  const hmac = opts.sharedSecret ? hmacMiddleware(opts.sharedSecret) : null;
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!hmac) return unavailable(res);
    hmac(req, res, next);
  });
  router.use((_req: Request, res: Response, next: NextFunction) => {
    if (!opts.storeAvailable || !opts.pool) return unavailable(res);
    next();
  });

  const handle =
    (
      fn: (
        pool: TelegramPairingPoolApi,
        sessionKey: string,
        res: Response,
        body: Record<string, unknown>
      ) => Promise<void>
    ) =>
    async (req: Request, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sessionKey = body.sessionKey;
      try {
        if (typeof sessionKey !== 'string') throw new InvalidSessionKeyError();
        await fn(opts.pool as TelegramPairingPoolApi, sessionKey, res, body);
      } catch (e) {
        if (e instanceof InvalidSessionKeyError) {
          res.status(400).json({ error: 'invalid_session_key' });
          return;
        }
        if (e instanceof InvalidPasswordError) {
          res.status(400).json({ error: 'invalid_password' });
          return;
        }
        if (e instanceof NotAwaitingPasswordError) {
          res.status(409).json({ error: 'password_not_requested' });
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
        logError(`telegram-pairing: ${req.path} failed: ${(e as Error)?.message || e}`);
        res.status(500).json({ error: 'internal_error' });
      }
    };

  // CONTRACT: http.telegram-pairing.internal-sessions.v1 — POST /start
  router.post(
    '/start',
    handle(async (pool, sessionKey, res) => {
      res.json(await pool.start(sessionKey));
    })
  );

  // CONTRACT: http.telegram-pairing.internal-sessions.v1 — POST /state
  router.post(
    '/state',
    handle(async (pool, sessionKey, res) => {
      res.json(await pool.status(sessionKey));
    })
  );

  // CONTRACT: http.telegram-pairing.internal-sessions.v1 — POST /me
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

  // CONTRACT: http.telegram-pairing.internal-sessions.v1 — POST /password
  // (the 2FA step of the QR flow; the password travels inside the HMAC body)
  router.post(
    '/password',
    handle(async (pool, sessionKey, res, body) => {
      const password = body.password;
      if (
        typeof password !== 'string' ||
        password === '' ||
        password.length > MAX_PASSWORD_LENGTH
      ) {
        throw new InvalidPasswordError();
      }
      res.json(await pool.submitPassword(sessionKey, password));
    })
  );

  app.use(INTERNAL_TELEGRAM_SESSIONS_BASE, router);
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  return app;
}
