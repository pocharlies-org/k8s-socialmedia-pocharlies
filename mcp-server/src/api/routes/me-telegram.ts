/**
 * SC-1229 (SC-1197 P4b): GET /me/telegram — the id/username of the CALLER's
 * own paired Telegram, read from the pool keyed by the JWT `sub`. A token of
 * A can never see B's identity: the sessionKey is A's sub and nothing else
 * is ever listed (design D3/D5 isolation). 404 not_paired when there is no
 * row; after a pool restart the answer comes from the row without the user
 * re-authorizing (lazy load in the pool).
 */
import { RequestHandler } from 'express';
import { IdentityRequest, SocialApiContext } from '../context';
import { RouteSpec } from '../router';
import { respondMeTelegram } from '../telegram-pairing-client';
import {
  PoolUnreachableError,
  respondPairingUnavailable,
} from '../whatsapp-pairing-client';

function handler(ctx: SocialApiContext): RequestHandler {
  return async (req, res) => {
    const pool = ctx.telegramPairing;
    const identity = (req as IdentityRequest).identity;
    if (!pool || !identity) {
      respondPairingUnavailable(res);
      return;
    }
    try {
      respondMeTelegram(res, await pool.post('me', identity.sub));
    } catch (err) {
      if (err instanceof PoolUnreachableError) {
        respondMeTelegram(res, err);
        return;
      }
      ctx.logError(`social-api: /me/telegram failed: ${(err as Error)?.message || err}`);
      respondPairingUnavailable(res);
    }
  };
}

// CONTRACT: http.social-api.me-telegram.v1
export const meTelegramRoute: RouteSpec = {
  method: 'get',
  path: '/me/telegram',
  auth: true,
  pool: 'telegram',
  make: handler,
};
