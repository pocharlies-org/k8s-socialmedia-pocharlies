/** Brain side of the job: push-ingest (shared lib) and delete-window (P3-c). */
import { pushToBrain, type BrainDoc, type BrainPushConfig } from '../brain-ingest-lib';

export interface BrainClient {
  push(instance: string, adapter: string, docs: BrainDoc[]): Promise<number>;
  deleteWindow(instance: string, windowId: string): Promise<void>;
}

/** 4xx (except 408/429) = the brain rejected the document itself: poison, log and move on (rule 5). */
export function isPoison(e: unknown): boolean {
  const m = /-> (4\d\d):/.exec(String((e as Error)?.message ?? e));
  return !!m && m[1] !== '408' && m[1] !== '429';
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
          // A 404 here means an unknown instance, and a 422 a window_id without 'cw:': never swallowed.
          if (resp.ok) return;
          const text = await resp.text().catch(() => '');
          last = new Error(
            `brain delete-window ${instance} -> ${resp.status}: ${text.slice(0, 300)}`
          );
          if (resp.status < 500) throw last;
        } catch (e) {
          last = e instanceof Error ? e : new Error(String(e));
          if (isPoison(last)) throw last;
        }
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
      throw last ?? new Error('delete-window failed');
    },
  };
}
