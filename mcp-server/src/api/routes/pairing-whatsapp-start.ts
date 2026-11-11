/**
 * SC-1227 (SC-1197 P1b): POST /pairing/whatsapp/start — begin a per-sub
 * WhatsApp pairing on the whatsapp-pairing pool.
 *
 * The sessionKey is the caller's JWT `sub`, never a client-supplied value
 * (identityGuard already rejected any `sub`/`sessionKey`/`jid` in the body or
 * query that differs from it). The pool applies the QR/start limits (429).
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
    const pool = ctx.whatsappPairing;
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
      ctx.logError(`social-api: /pairing/whatsapp/start failed: ${(err as Error)?.message || err}`);
      respondPairingUnavailable(res);
    }
  };
}

// CONTRACT: http.social-api.pairing-whatsapp.v1
export const pairingWhatsappStartRoute: RouteSpec = {
  method: 'post',
  path: '/pairing/whatsapp/start',
  auth: true,
  make: handler,
};
