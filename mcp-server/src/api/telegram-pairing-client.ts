/**
 * SC-1229 (SC-1197 P4b): the client `social-api` uses to reach the
 * `telegram-pairing` pool — the Telegram twin of whatsapp-pairing-client.ts.
 *
 * Same connector HMAC (shared's generateHMACSignature, the exact scheme the
 * pool verifies), same POST-only shape so the `sessionKey` travels inside
 * the signed body; /password additionally carries `password` in that signed
 * body. The generic status/limit mapping is imported from the whatsapp
 * client — one source of truth for the 503/429 choreography; this file adds
 * only the two telegram-specific answers (the /password 409 passthrough and
 * the {id, username} shape of /me/telegram).
 *
 * Like its twin, this client is constructed ONLY when TELEGRAM_PAIRING_URL
 * and the HMAC secret are set; the routes answer 503 pairing_unavailable
 * without it, and the storeGate checks THIS client for the telegram routes
 * (never the whatsapp one — architect note on the SC-1228 storeGate).
 */
import { Response } from 'express';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import {
  PoolResponse,
  PoolUnreachableError,
  respondPairingUnavailable,
} from './whatsapp-pairing-client';

// CONTRACT: http.telegram-pairing.internal-sessions.v1 — consumer side. The
// base path and the POST-only shape come from that entry; if the pool ever
// moves them, that is a breaking change for this file.
const INTERNAL_TELEGRAM_SESSIONS_BASE = '/internal/telegram/sessions';

export type TelegramPoolRoute = 'start' | 'state' | 'me' | 'password';

export class TelegramPairingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sharedSecret: string,
    private readonly timeoutMs = 10_000
  ) {}

  /**
   * POST { sessionKey, ...extra } to
   * `<TELEGRAM_PAIRING_URL>/internal/telegram/sessions/<route>` signed with
   * the connector HMAC. Returns the raw status/body for the route handler to
   * map; throws PoolUnreachableError on transport failure.
   */
  async post(
    route: TelegramPoolRoute,
    sessionKey: string,
    extra: Record<string, unknown> = {}
  ): Promise<PoolResponse> {
    const body = { sessionKey, ...extra };
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateHMACSignature(body, timestamp, this.sharedSecret);

    let res: globalThis.Response;
    try {
      res = await fetch(`${this.baseUrl}${INTERNAL_TELEGRAM_SESSIONS_BASE}/${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connector-Signature': signature,
          'X-Connector-Timestamp': String(timestamp),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new PoolUnreachableError(
        `telegram-pairing ${route} unreachable: ${(err as Error)?.message || err}`
      );
    }

    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
    } catch {
      // non-JSON body: keep {} and let the status mapping decide
    }
    return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
  }
}

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
