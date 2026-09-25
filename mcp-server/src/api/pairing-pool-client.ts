/**
 * SC-1229 round 2 (architect finding 2): the ONE client `social-api` uses to
 * reach a per-sub pairing pool. whatsapp-pairing (P1a) and telegram-pairing
 * (P4b) expose the same internal contract — POST-only routes under a
 * per-channel base, the `sessionKey` inside the HMAC-signed body — so the
 * request choreography and the generic status/limit mapping live here once
 * instead of being copied per channel.
 *
 * The channel modules (whatsapp-pairing-client.ts / telegram-pairing-client.ts)
 * keep what is channel's own: the base-path constant of their consumption
 * contract (the `// CONTRACT:` marker stays with the literal) and the
 * channel-specific answers (respondMeWhatsapp; respondMeTelegram and
 * respondPairingPassword). The base constants are read at CALL time inside
 * post(), which keeps the module graph free of an evaluation-order trap.
 *
 * The pool authenticates with the existing connector HMAC
 * (connectors/whatsapp-web/src/api/auth.ts createHMACAuth) — signed here
 * through shared's `generateHMACSignature`, the exact scheme the pools
 * verify. The signature covers `<timestamp>:<JSON body>`, so the
 * `sessionKey` travels inside the signed body: every pool route is a POST
 * and nothing goes in the path or the query (design D6).
 */
import { Response } from 'express';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { INTERNAL_TELEGRAM_SESSIONS_BASE } from './telegram-pairing-client';
import { INTERNAL_SESSIONS_BASE } from './whatsapp-pairing-client';

// CONTRACT: http.whatsapp-pairing.internal-sessions.v1 — consumer side: the
// base path and the POST-only shape come from that entry; if the pool ever
// moves them, that is a breaking change for this file too.
// CONTRACT: http.telegram-pairing.internal-sessions.v1 — consumer side, same
// statement for the telegram twin.

export type PairingPoolChannel = 'whatsapp' | 'telegram';

/** The pool routes, the union of both channels (whatsapp never posts /password). */
export type PairingPoolRoute = 'start' | 'state' | 'me' | 'password';

export interface PoolResponse {
  status: number;
  json: Record<string, unknown>;
  retryAfter: string | null;
}

/** The pool could not be reached at all (connection error, timeout). */
export class PoolUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoolUnreachableError';
  }
}

export class PairingPoolClient {
  constructor(
    private readonly channel: PairingPoolChannel,
    private readonly baseUrl: string,
    private readonly sharedSecret: string,
    private readonly timeoutMs = 10_000
  ) {}

  /**
   * POST { sessionKey, ...extra } to
   * `<baseUrl><internal-sessions-base>/<route>` signed with the connector
   * HMAC. Returns the raw status/body for the route handler to map; throws
   * PoolUnreachableError on transport failure.
   */
  async post(
    route: PairingPoolRoute,
    sessionKey: string,
    extra: Record<string, unknown> = {}
  ): Promise<PoolResponse> {
    const base =
      this.channel === 'whatsapp' ? INTERNAL_SESSIONS_BASE : INTERNAL_TELEGRAM_SESSIONS_BASE;
    const body = { sessionKey, ...extra };
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateHMACSignature(body, timestamp, this.sharedSecret);

    let res: globalThis.Response;
    try {
      res = await fetch(`${this.baseUrl}${base}/${route}`, {
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
        `${this.channel}-pairing ${route} unreachable: ${(err as Error)?.message || err}`
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

/** The one 503 this API answers for anything pool-side that is not usable. */
export function respondPairingUnavailable(res: Response): void {
  res.status(503).json({ error: 'pairing_unavailable' });
}

/**
 * Map a pool answer for /pairing/whatsapp* and /pairing/telegram (the poll
 * and /start): 200 passes the PairingStatus through, 429 passes the
 * rate-limit body + Retry-After through, anything else
 * (400/401/404/500/unreachable) is an internal inconsistency → 503.
 */
export function respondPairingStatus(
  res: Response,
  pool: PoolResponse | PoolUnreachableError
): void {
  if (pool instanceof PoolUnreachableError) {
    respondPairingUnavailable(res);
    return;
  }
  if (pool.status === 200) {
    res.status(200).json(pool.json);
    return;
  }
  if (pool.status === 429) {
    if (pool.retryAfter) res.setHeader('Retry-After', pool.retryAfter);
    res.status(429).json(pool.json);
    return;
  }
  if (pool.status === 503) {
    respondPairingUnavailable(res);
    return;
  }
  respondPairingUnavailable(res);
}
