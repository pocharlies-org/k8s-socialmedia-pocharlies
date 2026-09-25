/**
 * SC-1229 (SC-1197 P4b): GET /pairing/telegram — poll the pairing in
 * progress: state + QR + caducidad (the TelegramPairingStatus of the pool,
 * verbatim). QR by polling, not SSE (design D7, same as WhatsApp). No
 * parameters: the sessionKey is the JWT sub.
 */
import { RequestHandler } from 'express';
import { IdentityRequest, SocialApiContext } from '../context';
import { RouteSpec } from '../router';
import {
  PoolUnreachableError,
  respondPairingStatus,
  respondPairingUnavailable,
} from '../pairing-pool-client';

function handler(ctx: SocialApiContext): RequestHandler {
  return async (req, res) => {
    const pool = ctx.telegramPairing;
    const identity = (req as IdentityRequest).identity;
    if (!pool || !identity) {
      respondPairingUnavailable(res);
      return;
    }
    try {
      respondPairingStatus(res, await pool.post('state', identity.sub));
    } catch (err) {
      if (err instanceof PoolUnreachableError) {
        respondPairingStatus(res, err);
        return;
      }
      ctx.logError(`social-api: /pairing/telegram failed: ${(err as Error)?.message || err}`);
      respondPairingUnavailable(res);
    }
  };
}

// CONTRACT: http.social-api.pairing-telegram.v1
export const pairingTelegramRoute: RouteSpec = {
  method: 'get',
  path: '/pairing/telegram',
  auth: true,
  pool: 'telegram',
  make: handler,
};
