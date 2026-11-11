/**
 * SC-1227 (SC-1197 P1b): GET /me/whatsapp — the JID of the CALLER's own
 * paired WhatsApp, read from the pool keyed by the JWT `sub`. A token of A
 * can never see B's jid: the sessionKey is A's sub and nothing else is ever
 * listed (design D3/D5 isolation). 404 not_paired when there is no row.
 */
import { RequestHandler } from 'express';
import { IdentityRequest, SocialApiContext } from '../context';
import { RouteSpec } from '../router';
import { respondMeWhatsapp } from '../whatsapp-pairing-client';
import { PoolUnreachableError, respondPairingUnavailable } from '../pairing-pool-client';

function handler(ctx: SocialApiContext): RequestHandler {
  return async (req, res) => {
    const pool = ctx.whatsappPairing;
    const identity = (req as IdentityRequest).identity;
    if (!pool || !identity) {
      respondPairingUnavailable(res);
      return;
    }
    try {
      respondMeWhatsapp(res, await pool.post('me', identity.sub));
    } catch (err) {
      if (err instanceof PoolUnreachableError) {
        respondMeWhatsapp(res, err);
        return;
      }
      ctx.logError(`social-api: /me/whatsapp failed: ${(err as Error)?.message || err}`);
      respondPairingUnavailable(res);
    }
  };
}

// CONTRACT: http.social-api.me-whatsapp.v1
export const meWhatsappRoute: RouteSpec = {
  method: 'get',
  path: '/me/whatsapp',
  auth: true,
  make: handler,
};
