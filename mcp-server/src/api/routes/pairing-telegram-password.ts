/**
 * SC-1229 (SC-1197 P4b): POST /pairing/telegram/password — the 2FA step of
 * the Telegram QR flow (design D7). Body { password }: the pool is waiting
 * for it only while the flow sits in the `password` state (state seen via
 * GET /pairing/telegram); anything else is the pool's own 409
 * {"error":"password_not_requested"}, passed through.
 *
 * The password travels inside the body social-api signs with the connector
 * HMAC to the pool (in-cluster, TLS not needed on the pod network; never
 * logged here — the log lines name the route, never the body). A rejected
 * password returns the flow to `password`, so this route can be called
 * again. No `sub`/`sessionKey` accepted: identityGuard as everywhere.
 */
import { RequestHandler } from 'express';
import { IdentityRequest, SocialApiContext } from '../context';
import { RouteSpec } from '../router';
import { respondPairingPassword } from '../telegram-pairing-client';
import { PoolUnreachableError, respondPairingUnavailable } from '../pairing-pool-client';

/** Same bound the pool applies (Telegram's own limit is far below this). */
const MAX_PASSWORD_LENGTH = 1024;

function handler(ctx: SocialApiContext): RequestHandler {
  return async (req, res) => {
    const pool = ctx.telegramPairing;
    const identity = (req as IdentityRequest).identity;
    if (!pool || !identity) {
      respondPairingUnavailable(res);
      return;
    }
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== 'string' || password === '' || password.length > MAX_PASSWORD_LENGTH) {
      res.status(400).json({ error: 'invalid_password' });
      return;
    }
    try {
      respondPairingPassword(res, await pool.post('password', identity.sub, { password }));
    } catch (err) {
      if (err instanceof PoolUnreachableError) {
        respondPairingPassword(res, err);
        return;
      }
      ctx.logError(
        `social-api: /pairing/telegram/password failed: ${(err as Error)?.message || err}`
      );
      respondPairingUnavailable(res);
    }
  };
}

// CONTRACT: http.social-api.pairing-telegram.v1
export const pairingTelegramPasswordRoute: RouteSpec = {
  method: 'post',
  path: '/pairing/telegram/password',
  auth: true,
  pool: 'telegram',
  make: handler,
};
