/** Brain side of the job: push-ingest (shared lib) and delete-window (P3-c). */
import { pushToBrain, type BrainDoc, type BrainPushConfig } from '../brain-ingest-lib';

export interface BrainClient {
  push(instance: string, adapter: string, docs: BrainDoc[]): Promise<number>;
  deleteWindow(instance: string, windowId: string): Promise<void>;
}

/**
 * Poison = the brain REJECTED THE DOCUMENT: 400, 413, 422 only. Everything else that is not 2xx
 * (401/403 bad key, 404 unknown route or instance, 405, 408, 429, 5xx) is a configuration or
 * availability failure: it is thrown, counts as a failure and the cursor does not advance.
 */
export const POISON_STATUSES = [400, 413, 422];

export function isPoison(e: unknown): boolean {
  const m = /-> (\d{3}):/.exec(String((e as Error)?.message ?? e));
  return !!m && POISON_STATUSES.includes(Number(m[1]));
}

export function httpBrainClient(config: BrainPushConfig): BrainClient {
  return {
    push: (instance, adapter, docs) => pushToBrain(config, instance, adapter, docs),
    async deleteWindow(instance, windowId) {
      const url = `${config.brainUrl.replace(/\/$/, '')}/instances/${instance}/delete-window`;
      let last: Error | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(config.apiKey ? { 'X-API-Key': config.apiKey } : {}),
            },
            body: JSON.stringify({ window_id: windowId }),
            signal: AbortSignal.timeout(60_000),
          });
          // 200 covers {status: deleted|not_found}: the brain already makes it idempotent.
          // A 404 is an absent route or an unknown instance, a 422 a window_id without 'cw:': never success.
          if (resp.ok) return;
          const text = await resp.text().catch(() => '');
          last = new Error(
            `brain delete-window ${instance} -> ${resp.status}: ${text.slice(0, 300)}`
          );
          if (resp.status < 500) throw last; // 4xx is not retried
        } catch (e) {
          last = e instanceof Error ? e : new Error(String(e));
          if (/-> 4\d\d:/.test(last.message)) throw last;
        }
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
      throw last ?? new Error('delete-window failed');
    },
  };
}
