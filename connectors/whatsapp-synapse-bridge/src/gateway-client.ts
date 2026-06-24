import { createHmac } from 'crypto';
import type pino from 'pino';
import { MessageReceivedEvent } from '@mcp-socialmedia/shared';
import { withTimeout } from '@mcp-socialmedia/shared';

/**
 * Posts a surviving MessageReceivedEvent to the synapse gateway webhook.
 *
 * BYTE-IDENTITY INVARIANT: the event is serialized to a Buffer EXACTLY ONCE.
 * The HMAC is computed over those bytes and the SAME bytes are sent as the
 * request body. Re-serializing (even JSON.stringify of the same object) can
 * reorder keys / change whitespace and would make the gateway HMAC verification
 * fail (401). Never re-stringify between signing and sending.
 *
 * Signature: base64( HMAC_SHA256(secret, bytes) ), header
 *   X-Synapse-Whatsapp-Hmac-Sha256: <sig>
 *
 * Retry policy (NEVER drop on a transient failure):
 *   - network error / timeout / 5xx => retry the full budget (exp backoff+jitter, cap 60s)
 *   - 401 => config error; retry a BOUNDED number of times then log+metric+drop
 *   - 2xx => success
 *   - other 4xx (e.g. 400 bad payload) => non-retryable, log+metric+drop
 */

export interface GatewayResult {
  ok: boolean;
  /** 'delivered' | 'dropped-auth' | 'dropped-bad-request' | 'exhausted' */
  outcome: 'delivered' | 'dropped-auth' | 'dropped-bad-request' | 'exhausted';
  status?: number;
  attempts: number;
}

export interface GatewayClientOptions {
  url: string;
  secret: string;
  logger: pino.Logger;
  fetchImpl?: typeof fetch;
  /** Per-request timeout ms. */
  requestTimeoutMs?: number;
  /** Total attempts for retryable (5xx/network/timeout) failures. */
  maxAttempts?: number;
  /** Bounded attempts specifically for 401 (config error). */
  maxAuthAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Sleep + jitter overrides for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function signGatewayPayload(bytes: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(bytes).digest('base64');
}

export class GatewayClient {
  private readonly url: string;
  private readonly secret: string;
  private readonly logger: pino.Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxAuthAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(opts: GatewayClientOptions) {
    this.url = opts.url;
    this.secret = opts.secret;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.maxAuthAttempts = opts.maxAuthAttempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  /**
   * Forward the event. The caller passes the parsed event; we serialize ONCE
   * here so the bytes used for signing are the exact bytes sent. `logCtx` must
   * be PII-free (waMessageId + reason + account only).
   */
  async forward(
    event: MessageReceivedEvent,
    logCtx: { waMessageId: string; account?: string }
  ): Promise<GatewayResult> {
    // Serialize ONCE. These exact bytes are both signed and sent.
    const bytes = Buffer.from(JSON.stringify(event), 'utf8');
    const signature = signGatewayPayload(bytes, this.secret);

    let authAttempts = 0;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let status: number | undefined;
      try {
        const res = await withTimeout(
          this.fetchImpl(this.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Synapse-Whatsapp-Hmac-Sha256': signature,
            },
            body: bytes,
          }),
          this.requestTimeoutMs,
          'gateway webhook'
        );
        status = res.status;

        if (res.status >= 200 && res.status < 300) {
          this.logger.info({ ...logCtx, status, attempt }, 'forwarded to gateway');
          return { ok: true, outcome: 'delivered', status, attempts: attempt };
        }

        if (res.status === 401) {
          // Auth/config error: signature or secret mismatch. Bounded retries
          // (in case the gateway secret was just rotated and ESO is catching
          // up), then drop with a loud error + metric so it is visible.
          authAttempts++;
          this.logger.error(
            { ...logCtx, status, attempt, authAttempts },
            'gateway 401 (HMAC/secret mismatch) — config error'
          );
          if (authAttempts >= this.maxAuthAttempts) {
            return { ok: false, outcome: 'dropped-auth', status, attempts: attempt };
          }
          await this.backoff(attempt);
          continue;
        }

        if (res.status >= 400 && res.status < 500) {
          // Non-retryable client error (e.g. 400 malformed). Retrying won't
          // help; drop with a loud error rather than loop forever.
          this.logger.error(
            { ...logCtx, status, attempt },
            'gateway 4xx (non-retryable) — dropping'
          );
          return { ok: false, outcome: 'dropped-bad-request', status, attempts: attempt };
        }

        // 5xx => retryable.
        this.logger.warn({ ...logCtx, status, attempt }, 'gateway 5xx — will retry');
      } catch (error) {
        // Network error / timeout => retryable.
        this.logger.warn(
          { ...logCtx, attempt, err: error instanceof Error ? error.message : String(error) },
          'gateway request failed — will retry'
        );
      }

      if (attempt < this.maxAttempts) {
        await this.backoff(attempt);
      }
    }

    this.logger.error(
      { ...logCtx, attempts: this.maxAttempts },
      'gateway retry budget exhausted — message NOT delivered'
    );
    return { ok: false, outcome: 'exhausted', attempts: this.maxAttempts };
  }

  /** Exponential backoff with full jitter, capped at maxDelayMs. */
  private async backoff(attempt: number): Promise<void> {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    const jittered = Math.floor(this.random() * exp);
    await this.sleep(jittered);
  }
}
