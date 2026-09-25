/**
 * SC-1229 (SC-1197 P4b): POST /pairing/telegram/start — begin a per-sub
 * Telegram (mtcute QR) pairing on the telegram-pairing pool.
 *
 * The sessionKey is the caller's JWT `sub`, never a client-supplied value
 * (identityGuard already rejected any `sub`/`sessionKey`/`jid` in the body or
 * query that differs from it). The pool applies the QR/start limits (429).
 * The answer is the pool's TelegramPairingStatus: state starting|qr|password|
 * paired|expired|unpaired — the `password` state is the 2FA step, completed
 * through POST /pairing/telegram/password.
 */
import { RequestHandler } from 'express';
import { IdentityRequest, SocialApiContext } from '../context';
import { RouteSpec } from '../router';
import {
  PoolUnreachableError,
  respondPairingStatus,
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
      respondPairingStatus(res, await pool.post('start', identity.sub));
    } catch (err) {
      if (err instanceof PoolUnreachableError) {
        respondPairingStatus(res, err);
        return;
      }
      ctx.logError(`social-api: /pairing/telegram/start failed: ${(err as Error)?.message || err}`);
      respondPairingUnavailable(res);
    }
  };
}

// CONTRACT: http.social-api.pairing-telegram.v1
export const pairingTelegramStartRoute: RouteSpec = {
  method: 'post',
  path: '/pairing/telegram/start',
  auth: true,
  pool: 'telegram',
  make: handler,
};
