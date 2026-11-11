/**
 * INFRA-364 fase 0 — historical WhatsApp voice-note backfill (manual Job).
 *
 * Resumable and idempotent by construction: it only ever marks rows whose
 * `metadata->>'transcription_status' IS NULL` (never touched) as `pending`,
 * and the transcription pass itself is per-row idempotent (done rows are
 * skipped, failed rows keep their reason). Re-running after a crash, a killed
 * Job or a Whisper outage picks up exactly where it stopped — pending rows
 * (marked, not yet transcribed) are consumed by the pass; processing claims
 * older than STUCK_CLAIM_TIMEOUT_MS are recovered at the start of each pass.
 *
 * DRY_RUN defaults to TRUE: the command only reports, per account, how many
 * AUDIO/PTT rows still have empty content, how many have stored bytes (the
 * recoverable set) and how many would be marked. Run it first, look at the
 * numbers, then re-run with DRY_RUN=false to mark + transcribe.
 *
 * Env:
 *   DATABASE_URL        required (SC-1239 C2: no fallback)
 *   DRY_RUN             'true' (default) | 'false'
 *   VOICE_ACCOUNT       optional: scope the marking to one account
 *   VOICE_BACKFILL_MAX_ROWS  cap on rows marked per run, 0 = all (default 0)
 *   VOICE_RUN_AFTER_MARK     'true' (default): transcribe right after marking,
 *                            bounded by the same runtime/env as voice-transcribe
 *   VOICE_* / S3_* / MINIO_* see voice-transcribe.ts (shared pass options)
 *
 * Trigger (once the PR is merged and deployed):
 *   kubectl -n whatsapp-mcp create job voice-backfill-1 \
 *     --from=cronjob/whatsapp-voice-backfill
 *   # DRY_RUN=false is set on the created Job's pod template (or render the
 *   # Job yaml and edit it) — the CronJob itself keeps the safe default.
 */
import { Pool } from 'pg';
import pino from 'pino';
import { MinIOClient } from '../infrastructure/storage/minio-client';
import { runVoicePass, VoiceDeps, VoiceRowTally } from './voice-transcribe-lib';
import { backfillCountQuery, backfillMarkQuery, backfillReportQuery } from './voice-backfill-lib';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is unset: refusing to start the voice-backfill job without an explicit database connection'
  );
}

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const ACCOUNT = process.env.VOICE_ACCOUNT || undefined;
const MARK_MAX_ROWS = parseInt(process.env.VOICE_BACKFILL_MAX_ROWS || '0', 10);
const RUN_AFTER_MARK = (process.env.VOICE_RUN_AFTER_MARK ?? 'true').toLowerCase() !== 'false';

const STT_URL = process.env.VOICE_STT_URL || 'http://stt-turbo.llm.svc.cluster.local:8000';
const LANGUAGE = process.env.VOICE_LANGUAGE ?? 'es';
const BATCH = parseInt(process.env.VOICE_BATCH || '20', 10);
const CONCURRENCY = parseInt(process.env.VOICE_CONCURRENCY || '2', 10);
const MAX_ROWS = parseInt(process.env.VOICE_MAX_ROWS || '0', 10);
const MAX_RUNTIME_MS = parseInt(process.env.VOICE_MAX_RUNTIME_MS || '3300000', 10);
const MAX_ATTEMPTS = parseInt(process.env.VOICE_MAX_ATTEMPTS || '3', 10);
const ADOPT_WINDOW_DAYS = parseFloat(process.env.VOICE_ADOPT_WINDOW_DAYS || '7');
const MEDIA_GRACE_HOURS = parseFloat(process.env.VOICE_MEDIA_GRACE_HOURS || '6');
const STT_TIMEOUT_MS = parseInt(process.env.VOICE_STT_TIMEOUT_MS || '120000', 10);

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

  // 1. Report — what is there, what has bytes, what would be marked.
  const rep = backfillReportQuery(ACCOUNT);
  const report = await pool.query(rep.text, rep.params);
  logger.info({ dryRun: DRY_RUN, account: ACCOUNT ?? '*' }, 'voice-backfill report');
  for (const r of report.rows as Record<string, number | string>[]) {
    logger.info(
      { r },
      `account=${r.account} empty=${r.total} with_bytes=${r.with_bytes} ` +
        `done=${r.done} failed=${r.failed} queued=${r.queued} ` +
        `unmarked=${r.unmarked} unmarked_with_bytes=${r.recoverable}`
    );
  }
  const cnt = backfillCountQuery(ACCOUNT);
  const would = await pool.query(cnt.text, cnt.params);
  const toMark = would.rows[0]?.n ?? 0;

  // 2. Mark unmarked rows as pending (the resumable queue).
  if (DRY_RUN) {
    logger.info(
      { toMark },
      `DRY_RUN: would mark ${toMark} never-transcribed voice rows pending (set DRY_RUN=false to proceed)`
    );
  } else {
    const { text, params } = backfillMarkQuery({ account: ACCOUNT, maxRows: MARK_MAX_ROWS });
    const marked = await pool.query(text, params);
    logger.info({ marked: marked.rowCount }, 'voice-backfill: marked rows pending');
  }

  // 3. Consume the queue (unless this run was just for reporting).
  if (!DRY_RUN && RUN_AFTER_MARK) {
    const minio = new MinIOClient(
      process.env.MINIO_ENDPOINT || 'whatsapp-mcp-minio.whatsapp-mcp.svc.cluster.local',
      process.env.MINIO_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || '',
      process.env.MINIO_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY || '',
      process.env.MINIO_BUCKET || 'socialmedia-media',
      (process.env.MINIO_USE_SSL || 'false').toLowerCase() === 'true'
    );
    const deps: VoiceDeps = {
      pool,
      download: url => minio.downloadFile(url),
      stt: { url: STT_URL, timeoutMs: STT_TIMEOUT_MS },
      now: () => new Date(),
      logger,
    };
    const tally: VoiceRowTally = await runVoicePass(deps, {
      dryRun: false,
      adoptUnmarkedDays: ADOPT_WINDOW_DAYS,
      mediaGraceHours: MEDIA_GRACE_HOURS,
      maxAttempts: MAX_ATTEMPTS,
      language: LANGUAGE,
      account: ACCOUNT,
      batch: BATCH,
      concurrency: CONCURRENCY,
      maxRows: MAX_ROWS,
      maxRuntimeMs: MAX_RUNTIME_MS,
    });
    logger.info(
      tally,
      `voice-backfill pass: done=${tally.done} retried=${tally.pending} failed=${tally.failed} scanned=${tally.rows}`
    );
  }

  await pool.end();
}

main().catch(e => {
  logger.error({ err: e }, 'voice-backfill crashed');
  process.exit(1);
});
