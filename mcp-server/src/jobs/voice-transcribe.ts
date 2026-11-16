/**
 * INFRA-364 fase 0 — live voice-note transcription pass (CronJob entry).
 *
 * Every few minutes, transcribe the WhatsApp AUDIO/PTT rows the connector
 * marked `transcription_status=pending` at insert (plus recently-created
 * unmarked rows, adopted within VOICE_ADOPT_WINDOW_DAYS so a connector gap
 * never loses a fresh voice note). Historical rows are NOT adopted here — they
 * only enter the queue through voice-backfill.ts, so deploying this CronJob
 * cannot silently start the 4.5k-row historical run.
 *
 * Env:
 *   DATABASE_URL            required (SC-1239 C2: no fallback)
 *   VOICE_STT_URL           Whisper base URL (default stt-turbo in ns llm)
 *   VOICE_LANGUAGE          forced language, '' = auto-detect (default 'es';
 *                           empty results auto-retry with detection)
 *   VOICE_ACCOUNT           optional: personal|professional|leila only
 *   VOICE_BATCH             rows per claim (default 20)
 *   VOICE_CONCURRENCY       parallel STT requests (default 2 — stt-turbo is 1 replica)
 *   VOICE_MAX_ROWS          cap per run, 0 = no cap (default 0)
 *   VOICE_MAX_RUNTIME_MS    self-limit below activeDeadlineSeconds (default 240000)
 *   VOICE_MAX_ATTEMPTS      transient-failure retry budget (default 3)
 *   VOICE_ADOPT_WINDOW_DAYS adopt unmarked rows younger than N (default 7)
 *   VOICE_MEDIA_GRACE_HOURS wait for the async MinIO upload (default 6)
 *   VOICE_STT_TIMEOUT_MS    per-request timeout (default 120000)
 *   VOICE_DRY_RUN           'true' = read + call STT, write nothing (default false)
 *   S3_* / LEGACY_MINIO_* / MINIO_*  media storage (same as the mcp-server)
 */
import pino from 'pino';
import { runVoicePass, buildVoiceDeps } from './voice-transcribe-lib';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

const LANGUAGE = process.env.VOICE_LANGUAGE ?? 'es';
const ACCOUNT = process.env.VOICE_ACCOUNT || undefined;
const BATCH = parseInt(process.env.VOICE_BATCH || '20', 10);
const CONCURRENCY = parseInt(process.env.VOICE_CONCURRENCY || '2', 10);
const MAX_ROWS = parseInt(process.env.VOICE_MAX_ROWS || '0', 10);
const MAX_RUNTIME_MS = parseInt(process.env.VOICE_MAX_RUNTIME_MS || '240000', 10);
const MAX_ATTEMPTS = parseInt(process.env.VOICE_MAX_ATTEMPTS || '3', 10);
const ADOPT_WINDOW_DAYS = parseFloat(process.env.VOICE_ADOPT_WINDOW_DAYS || '7');
const MEDIA_GRACE_HOURS = parseFloat(process.env.VOICE_MEDIA_GRACE_HOURS || '6');
const DRY_RUN = process.env.VOICE_DRY_RUN === 'true';

async function main(): Promise<void> {
  const { pool, deps } = buildVoiceDeps(logger);
  const tally = await runVoicePass(deps, {
    dryRun: DRY_RUN,
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
    { ...tally, dryRun: DRY_RUN, account: ACCOUNT ?? '*' },
    `voice-transcribe pass: done=${tally.done} retried=${tally.pending} failed=${tally.failed} scanned=${tally.rows}`
  );
  await pool.end();
}

main().catch(e => {
  logger.error({ err: e }, 'voice-transcribe crashed');
  process.exit(1);
});
