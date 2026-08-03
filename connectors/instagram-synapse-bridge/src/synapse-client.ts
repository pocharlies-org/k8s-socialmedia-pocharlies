import { createHmac } from 'node:crypto';
import type pino from 'pino';

export type DeliveryOutcome = 'delivered' | 'retryable' | 'terminal';

export interface SynapseClientOptions {
  url: string;
  secret: string;
  logger: pino.Logger;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export function signInstagramPayload(raw: Uint8Array, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('base64');
}

/**
 * Sends the raw JetStream payload exactly once. It intentionally never
 * deserializes/re-serializes it, and it never logs request body data.
 */
export class SynapseClient {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: SynapseClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async forward(raw: Uint8Array): Promise<DeliveryOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Synapse-Instagram-Hmac-Sha256': signInstagramPayload(raw, this.options.secret),
        },
        body: Buffer.from(raw),
        signal: controller.signal,
      });
      if (response.status >= 200 && response.status < 300) return 'delivered';
      // Every receiver rejection is operationally recoverable: a 404 occurs
      // while the Synapse route is rolling out and a 401/403 occurs during
      // secret rotation. The locally validated event stays in JetStream until
      // the receiver accepts it; no customer DM is discarded during rollout.
      this.options.logger.warn({ status: response.status }, 'Synapse delivery will be retried');
      return 'retryable';
    } catch (error) {
      this.options.logger.warn(
        { error: error instanceof Error ? error.name : 'unknown' },
        'Synapse delivery failed and will be retried'
      );
      return 'retryable';
    } finally {
      clearTimeout(timer);
    }
  }
}
