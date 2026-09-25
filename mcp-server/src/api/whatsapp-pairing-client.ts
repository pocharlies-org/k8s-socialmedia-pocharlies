/**
 * SC-1227 (SC-1197 P1b): the client `social-api` uses to reach the
 * `whatsapp-pairing` pool.
 *
 * The pool authenticates with the existing connector HMAC
 * (connectors/whatsapp-web/src/api/auth.ts createHMACAuth) — reused here
 * through its twin in @mcp-socialmedia/shared, `generateHMACSignature`, which
 * is exactly what mcp-server already uses to sign its connector calls
 * (src/mcp/server.ts). The signature covers `<timestamp>:<JSON body>`, so the
 * `sessionKey` travels inside the signed body: every pool route is a POST and
 * nothing goes in the path or the query (design D6).
 *
 * The pool is the only persistence this API touches and it is the only thing
 * that ever writes a credential row: social-api itself opens no DB connection.
 */
import { Response } from 'express';
import { generateHMACSignature } from '@mcp-socialmedia/shared';

// CONTRACT: http.whatsapp-pairing.internal-sessions.v1 — consumer side. The
// base path and the POST-only shape come from that entry; if the pool ever
// moves them, that is a breaking change for this file.
const INTERNAL_SESSIONS_BASE = '/internal/whatsapp/sessions';

export type PoolRoute = 'start' | 'state' | 'me';

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

export class WhatsappPairingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sharedSecret: string,
    private readonly timeoutMs = 10_000
  ) {}

  /**
   * POST { sessionKey } to `<WHATSAPP_PAIRING_URL>/internal/whatsapp/sessions/<route>`
   * signed with the connector HMAC. Returns the raw status/body for the route
   * handler to map; throws PoolUnreachableError on transport failure.
   */
  async post(route: PoolRoute, sessionKey: string): Promise<PoolResponse> {
    const body = { sessionKey };
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateHMACSignature(body, timestamp, this.sharedSecret);

    let res: globalThis.Response;
    try {
      res = await fetch(`${this.baseUrl}${INTERNAL_SESSIONS_BASE}/${route}`, {
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
        `whatsapp-pairing ${route} unreachable: ${(err as Error)?.message || err}`
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
 * Map a pool answer for /pairing/whatsapp* : 200 passes the PairingStatus
 * through, 429 passes the rate-limit body + Retry-After through, anything
 * else (400/401/404/500/unreachable) is an internal inconsistency → 503.
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
