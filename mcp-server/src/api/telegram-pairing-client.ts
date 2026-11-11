/**
 * SC-1229 (SC-1197 P4b) — what is Telegram's own in the social-api →
 * telegram-pairing pool surface. Since SC-1229 round 2 the request
 * choreography and the generic status/limit mapping live once in
 * pairing-pool-client.ts (PairingPoolClient); this file keeps the base-path
 * constant of the consumption contract and the two answers that belong to
 * the mtcute QR flow: the 409 passthrough of /password and the
 * { id, username } shape of /me/telegram.
 *
 * Like its whatsapp twin, the client is constructed ONLY when
 * TELEGRAM_PAIRING_URL and the HMAC secret are set; the routes answer
 * 503 pairing_unavailable without it, and the storeGate checks the client of
 * the ROUTE's pool (never the other one — architect note on the SC-1228
 * storeGate).
 */
import { Response } from 'express';
import {
  PoolResponse,
  PoolUnreachableError,
  respondPairingUnavailable,
} from './pairing-pool-client';

// CONTRACT: http.telegram-pairing.internal-sessions.v1 — consumer side. The
// base path and the POST-only shape come from that entry; if the pool ever
// moves them, that is a breaking change for this file.
export const INTERNAL_TELEGRAM_SESSIONS_BASE = '/internal/telegram/sessions';

/**
 * Map a pool answer for POST /pairing/telegram/password: 200 passes the
 * PairingStatus through, 409 (the flow is not waiting for a password) is
 * passed through as the pool's own body, 429 passes the rate-limit body +
 * Retry-After through; anything else → 503.
 */
export function respondPairingPassword(
  res: Response,
  pool: PoolResponse | PoolUnreachableError
): void {
  if (pool instanceof PoolUnreachableError) {
    respondPairingUnavailable(res);
    return;
  }
  if (pool.status === 200 || pool.status === 409) {
    res.status(pool.status).json(pool.json);
    return;
  }
  if (pool.status === 429) {
    if (pool.retryAfter) res.setHeader('Retry-After', pool.retryAfter);
    res.status(429).json(pool.json);
    return;
  }
  respondPairingUnavailable(res);
}

/**
 * Map a pool answer for /me/telegram: 200 { me: {id, username} } →
 * { id, username }, 404 not_paired → 404, anything else → 503. Never echoes
 * another session's data: the pool keyed everything by the sessionKey we
 * signed.
 */
export function respondMeTelegram(res: Response, pool: PoolResponse | PoolUnreachableError): void {
  if (pool instanceof PoolUnreachableError) {
    respondPairingUnavailable(res);
    return;
  }
  if (pool.status === 404) {
    res.status(404).json({ error: 'not_paired' });
    return;
  }
  if (pool.status === 200) {
    const me = pool.json.me as { id?: unknown; username?: unknown } | null | undefined;
    if (me && typeof me.id === 'string') {
      res
        .status(200)
        .json({ id: me.id, username: typeof me.username === 'string' ? me.username : null });
      return;
    }
  }
  respondPairingUnavailable(res);
}
