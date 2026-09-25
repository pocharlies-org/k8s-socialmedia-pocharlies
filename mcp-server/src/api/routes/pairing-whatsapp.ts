/**
 * SC-1227 (SC-1197 P1b): GET /pairing/whatsapp — poll the pairing in progress:
 * state + QR + caducidad (the PairingStatus of the pool, verbatim). QR by
 * polling, not SSE (design D7). No parameters: the sessionKey is the JWT sub.
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
    const pool = ctx.whatsappPairing;
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
      ctx.logError(`social-api: /pairing/whatsapp failed: ${(err as Error)?.message || err}`);
      respondPairingUnavailable(res);
    }
  };
}

// CONTRACT: http.social-api.pairing-whatsapp.v1
export const pairingWhatsappRoute: RouteSpec = {
  method: 'get',
  path: '/pairing/whatsapp',
  auth: true,
  make: handler,
};
