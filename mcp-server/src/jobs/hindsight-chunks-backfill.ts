/**
 * SC-4304 S8: backfill of the message history into Hindsight (bank `personal`), through the boundary
 * writer with the identity `socialmedia-mensajes`.
 *
 * Walks the `brain_windows` ledger of the personal namespace in `source_id` order and writes every
 * chunk the reader will later resolve: the window is reloaded and chunked with the SAME builder the
 * reader uses (`loadWindowForLlm` + `chunkWindow`), `document_id` is the chunk's `source_id`
 * (`win:…#cN`) and the writer hashes it per identity. Account, conversation and message ids are not
 * sent: the reader recovers them from the ledger (see application/hindsight-chunks.ts).
 *
 * Resumable and idempotent: the cursor (`brain_windows_backfill_cursor`) only advances after a whole
 * page is confirmed (`async:false`), and re-retaining the same document id replaces it. A 401/403 is the
 * token not matching the identity: it stops at once, it is never retried.
 */
import { Pool } from 'pg';
import pino from 'pino';
import {
  chunkWindow,
  ensureBrainWindowsTables,
  getBackfillCursor,
  loadWindowForLlm,
  setBackfillCursor,
  type BuiltChunk,
  type PendingLlmWindow,
} from './brain-windows-lib';
import { createLimiter } from './brain-window-llm';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

export const RUN_ID = 'sc4304-hindsight';
const BANK = 'personal';
const WRITER_BATCH = 32; // the writer rejects more items per request
const RETRYABLE = new Set([0, 429, 502, 503, 504]);

export class FatalWriterError extends Error {}

export interface BackfillConfig {
  writerUrl: string;
  token: string;
  accounts: string[];
  pageWindows: number;
  /** Stop after this many items (0 = no limit): the first small batch of a rollout. */
  maxItems: number;
  maxRuntimeMs: number;
  /** The writer has 4 slots shared with every client: stay at 2. */
  concurrency: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv): BackfillConfig {
  const token = env.HINDSIGHT_WRITER_TOKEN?.trim() || '';
  if (!token) throw new Error('HINDSIGHT_WRITER_TOKEN is unset');
  const int = (name: string, fallback: number): number => {
    const n = Number(env[name]);
    return Number.isInteger(n) && n >= 0 && env[name]?.trim() ? n : fallback;
  };
  return {
    writerUrl: (env.HINDSIGHT_WRITER_URL || 'https://hindsight-writer.hindsight.svc:8443').replace(
      /\/+$/,
      ''
    ),
    token,
    accounts: (env.ACCOUNTS || 'personal')
      .split(',')
      .map(a => a.trim())
      .filter(Boolean),
    pageWindows: Math.max(1, int('PAGE_WINDOWS', 40)),
    maxItems: int('MAX_ITEMS', 0),
    maxRuntimeMs: int('MAX_RUNTIME_MS', 3_000_000),
    concurrency: Math.min(2, Math.max(1, int('CONCURRENCY', 2))),
  };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function chunkItems(
  window: Pick<PendingLlmWindow, 'account' | 'platform' | 'end_ts'>,
  chunks: BuiltChunk[]
): Array<Record<string, unknown>> {
  return chunks.map(c => ({
    document_id: c.source_id,
    content: c.content,
    timestamp: new Date(window.end_ts).toISOString(),
    tags: ['type:conversation_chunk', `account:${window.account}`, `platform:${window.platform}`],
    strategy: 'vector',
    metadata: { source: 'socialmedia-backfill', kind: 'conversation_chunk' },
  }));
}

export async function retain(
  fetchImpl: FetchLike,
  cfg: Pick<BackfillConfig, 'writerUrl' | 'token'>,
  items: Array<Record<string, unknown>>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    try {
      const response = await fetchImpl(`${cfg.writerUrl}/v1/default/banks/${BANK}/memories`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ items, async: false }),
        signal: AbortSignal.timeout(300_000),
      });
      status = response.status;
      if (response.ok) return;
    } catch {
      status = 0; // transport error: retried like a busy writer
    }
    if (status === 401 || status === 403)
      throw new FatalWriterError(
        `writer ${status}: the token does not match identity socialmedia-mensajes`
      );
    if (attempt >= 4 || !RETRYABLE.has(status))
      throw new Error(`writer ${status} after ${attempt + 1} tries`);
    await sleep(2000 * 2 ** attempt);
  }
}

export async function runBackfill(
  pool: Pool,
  cfg: BackfillConfig,
  fetchImpl: FetchLike = fetch
): Promise<{ windows: number; items: number; requests: number; done: boolean }> {
  const deadline = Date.now() + cfg.maxRuntimeMs;
  const limit = createLimiter(cfg.concurrency);
  const totals = { windows: 0, items: 0, requests: 0, done: false };
  let after = (await getBackfillCursor(pool, RUN_ID, 'hindsight'))?.last_source_id ?? '';
  while (Date.now() < deadline && (!cfg.maxItems || totals.items < cfg.maxItems)) {
    const { rows } = await pool.query(
      `SELECT source_id, account, platform, conversation_id, window_key, part, start_ts, end_ts,
              message_count, conv_kind, content_hash, llm_input_hash
         FROM brain_windows
        WHERE account = ANY($1::text[]) AND chunk_count > 0 AND source_id > $2
        ORDER BY source_id LIMIT $3`,
      [cfg.accounts, after, cfg.pageWindows]
    );
    if (!rows.length) {
      totals.done = true;
      break;
    }
    const items: Array<Record<string, unknown>> = [];
    for (const row of rows as PendingLlmWindow[]) {
      const built = await loadWindowForLlm(pool, row);
      if (built) items.push(...chunkItems(row, chunkWindow(built)));
    }
    const batches: Array<typeof items> = [];
    for (let i = 0; i < items.length; i += WRITER_BATCH)
      batches.push(items.slice(i, i + WRITER_BATCH));
    await Promise.all(batches.map(batch => limit(() => retain(fetchImpl, cfg, batch))));
    after = rows[rows.length - 1].source_id;
    await setBackfillCursor(pool, RUN_ID, 'hindsight', { last_source_id: after });
    totals.windows += rows.length;
    totals.items += items.length;
    totals.requests += batches.length;
    logger.info({ ...totals, cursor: after }, 'hindsight chunks backfill page confirmed');
  }
  return totals;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is unset');
  const cfg = configFromEnv(process.env);
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await ensureBrainWindowsTables(pool);
    const totals = await runBackfill(pool, cfg);
    logger.info({ ...totals, maxItems: cfg.maxItems }, 'hindsight chunks backfill pass finished');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      logger.error({ err: String(err) }, 'hindsight-chunks-backfill failed');
      process.exit(1);
    });
}
