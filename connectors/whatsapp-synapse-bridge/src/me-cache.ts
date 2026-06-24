import { createHmac } from 'crypto';
import type pino from 'pino';
import { withTimeout } from '@mcp-socialmedia/shared';

/**
 * Caches the bridge account's own WhatsApp JID, fetched from the professional
 * connector's GET /api/v1/me using the connector HMAC scheme.
 *
 * FAIL-CLOSED contract: if /me has never succeeded, getOwnJid() returns '' so
 * the filter drops EVERYTHING (it cannot rule out a reply-to-self loop without
 * knowing its own identity). We only return a JID once a real /me call has
 * populated the cache. A stale-but-once-valid JID is kept while refresh fails
 * (own JID is effectively immutable for a linked device, so stale is safe;
 * unknown is not).
 */

/** Connector HMAC: sha256=<hex> over `${timestamp}:${JSON.stringify(body)}`. */
function signConnectorRequest(
  body: unknown,
  timestampSec: number,
  sharedSecret: string
): string {
  const message = `${timestampSec}:${JSON.stringify(body)}`;
  const hex = createHmac('sha256', sharedSecret).update(message).digest('hex');
  return `sha256=${hex}`;
}

export interface MeCacheOptions {
  connectorUrl: string;
  connectorSharedSecret: string;
  ttlMs: number;
  logger: pino.Logger;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. */
  requestTimeoutMs?: number;
  now?: () => number;
}

export class MeCache {
  private cachedJid: string | null = null;
  private fetchedAt = 0;
  private inFlight: Promise<string | null> | null = null;

  private readonly connectorUrl: string;
  private readonly connectorSharedSecret: string;
  private readonly ttlMs: number;
  private readonly logger: pino.Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts: MeCacheOptions) {
    this.connectorUrl = opts.connectorUrl.replace(/\/+$/, '');
    this.connectorSharedSecret = opts.connectorSharedSecret;
    this.ttlMs = opts.ttlMs;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Return the cached own JID, refreshing in the background when stale. Returns
   * '' (fail-closed) when no JID has ever been obtained. Never throws.
   */
  async getOwnJid(): Promise<string> {
    const fresh = this.cachedJid !== null && this.now() - this.fetchedAt < this.ttlMs;
    if (fresh) return this.cachedJid as string;

    // Stale or never-fetched: try to (re)fetch. Coalesce concurrent refreshes.
    const refreshed = await this.refresh();
    if (refreshed) return refreshed;

    // Refresh failed. If we have a previously-valid JID, keep using it (stale
    // own-JID is safe; it is effectively immutable for a linked device).
    if (this.cachedJid !== null) return this.cachedJid;

    // No JID ever obtained => fail closed.
    return '';
  }

  /** True once /me has succeeded at least once (for /status). */
  isReady(): boolean {
    return this.cachedJid !== null;
  }

  private refresh(): Promise<string | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doFetch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doFetch(): Promise<string | null> {
    const url = `${this.connectorUrl}/api/v1/me`;
    const timestampSec = Math.floor(this.now() / 1000);
    // Connector verifies `${timestamp}:${JSON.stringify(req.body)}`. For a GET
    // with Content-Type application/json and no body, express.json() yields
    // req.body = {} => "{}", so we sign over the empty object. We must NOT send
    // a body on the wire: fetch/undici rejects a GET/HEAD with a body
    // ("Request with GET/HEAD method cannot have body."). Verified against the
    // live connector: bodyless GET + signature over `${ts}:{}` returns 200.
    const body = {};
    const signature = signConnectorRequest(body, timestampSec, this.connectorSharedSecret);

    try {
      const res = await withTimeout(
        this.fetchImpl(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Connector-Signature': signature,
            'X-Connector-Timestamp': String(timestampSec),
          },
        }),
        this.requestTimeoutMs,
        'connector /me'
      );

      if (!res.ok) {
        this.logger.error(
          { status: res.status, ready: this.isReady() },
          'FAIL-CLOSED: connector /me returned non-2xx; own-JID not refreshed'
        );
        return null;
      }

      const payload = (await res.json()) as { id?: unknown };
      const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
      if (!id) {
        this.logger.error(
          { ready: this.isReady() },
          'FAIL-CLOSED: connector /me returned no id; own-JID not refreshed'
        );
        return null;
      }

      this.cachedJid = id;
      this.fetchedAt = this.now();
      this.logger.info('connector /me ok: own-JID cached');
      return id;
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error), ready: this.isReady() },
        'FAIL-CLOSED: connector /me fetch failed; own-JID not refreshed'
      );
      return null;
    }
  }
}

export { signConnectorRequest };
