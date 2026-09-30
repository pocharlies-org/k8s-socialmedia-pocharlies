/**
 * INFRA-364 — one-shot data fix: rewrite voice-echo rows whose `content` is
 * the raw ASR response body (`🎙️ "{"text":"…","usage":null}"`) to the clean
 * transcript, and stamp `metadata.transcription_fixed_at` on every row it
 * touches. Root cause (the bots echoing the STT body) is fixed at ingest in
 * connectors/telegram-sync (mapping.unwrap_asr_json); this job heals history.
 *
 * Resumable and idempotent by construction: already-fixed rows carry the
 * marker (and no longer match the shape), the walk is a keyset on id, and
 * every UPDATE is guarded on the exact old content — a crashed or killed run
 * restarts cleanly, and re-running after completion is a no-op.
 *
 * DRY_RUN defaults to TRUE: the pass only reports the per-platform/account
 * census and previews the first unwrapped rows. Look at the numbers, then
 * re-run with DRY_RUN=false.
 *
 * Env:
 *   DATABASE_URL    required (SC-1239 C2: no fallback)
 *   DRY_RUN         'true' (default) | 'false'
 *   FIX_PLATFORM    optional scope: 'telegram' | 'whatsapp'
 *   FIX_ACCOUNT     optional scope: personal | professional | leila
 *   FIX_BATCH       candidate rows fetched per round (default 100)
 *   FIX_MAX_ROWS    candidate rows processed per run, 0 = all (default 0)
 *
 * Trigger (once merged and deployed — the mcp-server container carries the
 * DATABASE_URL and the job sources):
 *   # report only:
 *   kubectl -n whatsapp-mcp exec deploy/mcp-server -- \
 *     sh -c 'cd mcp-server && node --import tsx src/jobs/voice-json-fix.ts'
 *   # the real pass:
 *   kubectl -n whatsapp-mcp exec deploy/mcp-server -- \
 *     sh -c 'cd mcp-server && DRY_RUN=false node --import tsx src/jobs/voice-json-fix.ts'
 *
 * Each UPDATE fires the `messages` updated_at trigger from migration 016 (once
 * applied) so the brain window builder re-renders the fixed rows — intended.
 */
import { Pool } from 'pg';
import pino from 'pino';
import {
  FIX_UPDATE_SQL,
  fixCandidatesQuery,
  fixCountQuery,
  unwrapAsrJson,
} from './voice-json-fix-lib';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is unset: refusing to start the voice-json-fix job without an explicit database connection'
  );
}

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const PLATFORM = process.env.FIX_PLATFORM || undefined;
const ACCOUNT = process.env.FIX_ACCOUNT || undefined;
const BATCH = parseInt(process.env.FIX_BATCH || '100', 10);
const MAX_ROWS = parseInt(process.env.FIX_MAX_ROWS || '0', 10);

const PREVIEW_LIMIT = 10;

function preview(content: string, n = 70): string {
  const flat = content.replace(/\s+/g, ' ');
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

  // 1. Census — candidate heads per platform/account (exact shape check in TS).
  const cnt = fixCountQuery({ platform: PLATFORM, account: ACCOUNT });
  const census = await pool.query(cnt.text, cnt.params);
  logger.info(
    { dryRun: DRY_RUN, platform: PLATFORM ?? '*', account: ACCOUNT ?? '*' },
    'voice-json-fix census'
  );
  for (const r of census.rows as { platform: string; account: string; candidates: number }[]) {
    logger.info(`  ${r.platform}/${r.account}: ${r.candidates} candidate rows`);
  }

  // 2. Keyset walk: fetch candidates, unwrap in TS, guarded UPDATE per row.
  let cursor = '0';
  let scanned = 0;
  let fixed = 0;
  let skipped = 0;
  for (;;) {
    const remaining = MAX_ROWS > 0 ? MAX_ROWS - scanned : Infinity;
    if (remaining <= 0) break;
    const limit = Math.min(BATCH, remaining);
    const { text, params } = fixCandidatesQuery({
      platform: PLATFORM,
      account: ACCOUNT,
      afterId: cursor,
      limit,
    });
    const res = await pool.query(text, params);
    const rows = res.rows as { id: string; content: string }[];
    if (rows.length === 0) break;
    for (const row of rows) {
      scanned += 1;
      cursor = String(row.id);
      const clean = unwrapAsrJson(row.content);
      if (clean === null || clean === row.content) {
        // Head matched (🎙/JSON prefix) but the body is prose — never rewrite.
        skipped += 1;
        continue;
      }
      if (DRY_RUN) {
        fixed += 1;
        if (fixed <= PREVIEW_LIMIT) {
          logger.info({ id: row.id }, `  would fix: ${preview(row.content)}  →  ${preview(clean)}`);
        }
        continue;
      }
      const up = await pool.query(FIX_UPDATE_SQL, [
        row.id,
        clean,
        new Date().toISOString(),
        row.content,
      ]);
      if ((up.rowCount ?? 0) > 0) fixed += 1;
      else skipped += 1; // content changed under us or already fixed — next pass decides
    }
    if (rows.length < limit) break;
  }

  logger.info(
    { scanned, fixed, skipped },
    `voice-json-fix ${DRY_RUN ? 'report (no writes)' : 'pass'}: scanned=${scanned} ` +
      `${DRY_RUN ? 'wouldFix' : 'fixed'}=${fixed} skipped=${skipped}`
  );
  await pool.end();
}

main().catch(e => {
  logger.error({ err: e }, 'voice-json-fix crashed');
  process.exit(1);
});
