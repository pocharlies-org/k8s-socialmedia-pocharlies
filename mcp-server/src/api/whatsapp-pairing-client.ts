/**
 * SC-1227 (SC-1197 P1b) — what is WhatsApp's own in the social-api →
 * whatsapp-pairing pool surface. Since SC-1229 round 2 the request
 * choreography and the generic status/limit mapping live once in
 * pairing-pool-client.ts (PairingPoolClient); this file keeps the
 * base-path constant of the consumption contract and the one answer that
 * belongs to baileys: the { jid } shape of /me/whatsapp.
 *
 * The pool is the only persistence this API touches and it is the only thing
 * that ever writes a credential row: social-api itself opens no DB connection.
 */
import { Response } from 'express';
import {
  PoolResponse,
  PoolUnreachableError,
  respondPairingUnavailable,
} from './pairing-pool-client';

// CONTRACT: http.whatsapp-pairing.internal-sessions.v1 — consumer side. The
// base path and the POST-only shape come from that entry; if the pool ever
// moves them, that is a breaking change for this file.
export const INTERNAL_SESSIONS_BASE = '/internal/whatsapp/sessions';

/**
 * Map a pool answer for /me/whatsapp : 200 { me } → { jid }, 404 not_paired →
 * 404, anything else → 503. Never echoes another session's data: the pool
 * already keyed everything by the sessionKey we signed.
 */
export function respondMeWhatsapp(res: Response, pool: PoolResponse | PoolUnreachableError): void {
  if (pool instanceof PoolUnreachableError) {
    respondPairingUnavailable(res);
    return;
  }
  if (pool.status === 404) {
    res.status(404).json({ error: 'not_paired' });
    return;
  }
  if (pool.status === 200) {
    const me = pool.json.me as { jid?: unknown } | null | undefined;
    if (me && typeof me.jid === 'string') {
      res.status(200).json({ jid: me.jid });
      return;
    }
  }
  respondPairingUnavailable(res);
}
