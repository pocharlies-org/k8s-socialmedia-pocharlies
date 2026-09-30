/**
 * INFRA-364 fase 0 — WhatsApp voice-note transcription (AUDIO/PTT).
 *
 * WhatsApp AUDIO/PTT rows land with `content = NULL` (convertMessage sets the
 * body to null for audioMessage; the bytes ride separately to MinIO via the
 * connector's downloadAndStoreMedia). The brain only embeds `content`, so those
 * ~4.5k voice notes are invisible to it. This lib closes the gap the same way
 * Telegram does (connectors/telegram-sync/sync/db.py): the worker picks pending
 * voice rows, fetches the stored audio from MinIO, POSTs it to the in-cluster
 * Whisper service and writes the text into `content`, tracking
 * `metadata.transcription_status` (pending → processing → done/failed),
 * `transcription_attempts` and `transcription_error` with the SAME key names
 * the Telegram sync uses, so consumers (window builder, brain) see one shape.
 *
 * Unlike telegram-sync (which runs faster-whisper in-process on CPU), this
 * worker is a thin client of `stt-turbo` (ns `llm`, whisper-large-v3,
 * OpenAI-compatible POST /v1/audio/transcriptions). The GPU stays where it
 * already is: the worker schedules on the regular LAN amd64 nodes like every
 * other whatsapp-mcp workload — nothing new lands on the Sparks.
 *
 * Retry semantics (deliberate divergence from telegram-sync, whose failed rows
 * are terminal): transient errors (STT unreachable/5xx, media still uploading)
 * go back to `pending` and burn one of VOICE_MAX_ATTEMPTS retries, so a Whisper
 * restart mid-backfill does not permanently kill thousands of rows. Permanent
 * errors (object gone from MinIO, no attachment after the grace window, empty
 * transcription) are terminal `failed` with the reason in transcription_error.
 */
import { Pool } from 'pg';

/** WhatsApp message types that carry voice audio. */
export const VOICE_MESSAGE_TYPES = ['AUDIO', 'PTT'] as const;

/** A `processing` claim older than this is considered abandoned (crash). */
export const STUCK_CLAIM_TIMEOUT_MS = 30 * 60_000;

export interface VoiceRow {
  id: string;
  account: string;
  message_type: string;
  created_at: Date;
  wa_timestamp: Date;
  /** metadata->>'transcription_status' — null when the row was never marked. */
  status: string | null;
  attempts: number;
  /** Latest AUDIO/PTT attachment, when the bytes were persisted. */
  attachment_id: string | null;
  file_url: string | null;
  mime_type: string | null;
}

export interface PendingQueryOptions {
  /** Scope to one account (personal|professional|leila); undefined = all. */
  account?: string;
  /**
   * Unmarked rows (transcription_status IS NULL) created at/after this instant
   * are adopted as pending — the safety net for rows written before the
   * connector started marking, or by paths that bypass it. Older unmarked rows
   * are ONLY reachable through voice-backfill marking, so deploying the live
   * worker never silently kicks off the historical run.
   */
  adoptUnmarkedSince?: Date;
  limit: number;
  maxAttempts: number;
}

/**
 * Keyset-free queue: pending first (oldest message wins), then adoptable
 * unmarked rows. `is_deleted = false` (the column is NOT NULL default false).
 */
export function pendingRowsQuery(opts: PendingQueryOptions): { text: string; params: unknown[] } {
  const params: unknown[] = [opts.maxAttempts];
  let text = `
SELECT m.id, m.account, m.message_type, m.created_at, m.wa_timestamp,
       m.metadata->>'transcription_status' AS status,
       COALESCE((m.metadata->>'transcription_attempts')::int, 0) AS attempts,
       a.id AS attachment_id, a.file_url, a.mime_type
FROM messages m
LEFT JOIN LATERAL (
  SELECT id, file_url, mime_type FROM attachments
   WHERE message_id = m.id AND file_type IN ('AUDIO','PTT')
   ORDER BY id DESC LIMIT 1
) a ON TRUE
WHERE m.platform = 'whatsapp'
  AND m.is_deleted = false
  AND m.message_type IN ('AUDIO','PTT')
  AND btrim(COALESCE(m.content,'')) = ''
  AND COALESCE((m.metadata->>'transcription_attempts')::int, 0) < $1`;
  if (opts.adoptUnmarkedSince) {
    params.push(opts.adoptUnmarkedSince);
    text += `
  AND (
    m.metadata->>'transcription_status' = 'pending'
    OR (m.metadata->>'transcription_status' IS NULL AND m.created_at >= $${params.length})
  )`;
  } else {
    text += `\n  AND m.metadata->>'transcription_status' = 'pending'`;
  }
  if (opts.account) {
    params.push(opts.account);
    text += `\n  AND m.account = $${params.length}`;
  }
  params.push(opts.limit);
  text += `\nORDER BY m.wa_timestamp ASC, m.id ASC\nLIMIT $${params.length}`;
  return { text, params };
}

/**
 * Flip a row to `processing` (claimed by this pass). The claim instant rides in
 * metadata so crash recovery can tell "being worked on" from "abandoned"
 * without a schema change (messages has no updated_at until INFRA-364 §6).
 */
export async function markProcessing(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE messages
        SET metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object(
               'transcription_status', 'processing',
               'transcription_claimed_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
             )
      WHERE id = $1`,
    [id]
  );
}

/**
 * Write the transcription into `content` and close the row. The status guard
 * makes the write idempotent: a second pass (or a racing worker) never
 * overwrites an already-done transcription, and a caption that appeared in the
 * meantime is only replaced while the row is still un-transcribed.
 */
export async function completeTranscription(
  pool: Pool,
  id: string,
  text: string,
  language: string | null,
  dryRun = false
): Promise<void> {
  if (dryRun) return;
  const patch: Record<string, unknown> = {
    transcription_status: 'done',
    transcribed_at: new Date().toISOString(),
  };
  if (language) patch.transcription_language = language;
  await pool.query(
    `UPDATE messages
        SET content = $2,
            metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
      WHERE id = $1
        AND COALESCE(metadata->>'transcription_status', 'pending') <> 'done'`,
    [id, text, JSON.stringify(patch)]
  );
}

export interface FailOptions {
  /** true: transient — back to `pending`, burning one attempt. false: terminal. */
  retry: boolean;
  /**
   * Set false with retry:true for pure waiting (media upload still in flight):
   * the row goes back to pending WITHOUT burning one of the attempt budget, so
   * a slow connector upload cannot exhaust retries before the grace window.
   */
  bumpAttempts?: boolean;
  maxAttempts: number;
  dryRun?: boolean;
}

/**
 * Record a failure. `retry` keeps the row pending (attempt burned); once the
 * attempt budget is exhausted — or for permanent errors — the row is `failed`.
 */
export async function failTranscription(
  pool: Pool,
  id: string,
  currentAttempts: number,
  error: string,
  opts: FailOptions
): Promise<void> {
  if (opts.dryRun) return;
  const bump = opts.retry && opts.bumpAttempts !== false;
  const attempts = currentAttempts + (bump ? 1 : 0);
  const terminal = !opts.retry || attempts >= opts.maxAttempts;
  const patch: Record<string, unknown> = {
    transcription_status: terminal ? 'failed' : 'pending',
    transcription_error: error.slice(0, 500),
  };
  // Only write the counter when it actually moves: a waiting row must not
  // reset a previously burned attempt count back to zero.
  if (bump) patch.transcription_attempts = attempts;
  await pool.query(
    `UPDATE messages
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE id = $1`,
    [id, JSON.stringify(patch)]
  );
}

/**
 * Crash recovery: rows left in `processing` by a killed pass go back to
 * `pending` (mirrors telegram-sync's recover_stuck_transcriptions). The claim
 * timestamp in metadata decides staleness; rows claimed before the column
 * existed (no claim stamp) fall back to `created_at` so they can never be
 * stuck forever. Returns the number recovered.
 */
export async function recoverStuckProcessing(pool: Pool, olderThanMs: number): Promise<number> {
  const res = await pool.query(
    `UPDATE messages
        SET metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object('transcription_status', 'pending')
      WHERE platform = 'whatsapp'
        AND message_type IN ('AUDIO','PTT')
        AND metadata->>'transcription_status' = 'processing'
        AND btrim(COALESCE(content,'')) = ''
        AND COALESCE(
              (metadata->>'transcription_claimed_at')::timestamptz,
              created_at
            ) < NOW() - ($1 * interval '1 millisecond')`,
    [olderThanMs]
  );
  return res.rowCount ?? 0;
}

// --- STT client ---------------------------------------------------------------

export interface SttConfig {
  /** Base URL of the Whisper service, e.g. http://stt-turbo.llm.svc:8000 */
  url: string;
  /** ISO language code to force ('es'), or '' / undefined for auto-detect. */
  language?: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface SttResult {
  text: string;
  language: string | null;
}

/**
 * POST the audio to the OpenAI-compatible endpoint
 * (`/v1/audio/transcriptions`, multipart: file + language + response_format).
 * Throws on non-2xx / network errors — callers classify as transient.
 */
export async function sttTranscribe(
  cfg: SttConfig,
  audio: Buffer,
  filename: string,
  contentType: string
): Promise<SttResult> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: contentType }), filename);
  if (cfg.language) form.append('language', cfg.language);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const res = await doFetch(`${cfg.url.replace(/\/+$/, '')}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`stt http ${res.status}: ${body.slice(0, 200)}`);
  }
  return parseSttResponse(await res.json());
}

/** Tolerant parser for the whisper-server JSON shape ({text, language, ...}). */
export function parseSttResponse(body: unknown): SttResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  const language = typeof b.language === 'string' && b.language ? b.language : null;
  return { text, language };
}

/** Map a stored mime type to a whisper-friendly filename extension. */
export function audioFilename(mime: string | null | undefined): { name: string; type: string } {
  const m = (mime || '').toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return { name: 'voice.mp3', type: 'audio/mpeg' };
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a'))
    return { name: 'voice.m4a', type: 'audio/mp4' };
  // Legacy rows stored `.bin` with mime `audio/ogg; codecs=opus` — the bytes are
  // real Ogg/Opus (verified against MinIO), so .ogg is the honest name.
  return { name: 'voice.ogg', type: 'audio/ogg' };
}

// --- per-row pipeline -----------------------------------------------------------

export interface VoiceDeps {
  pool: Pool;
  /** Fetch stored bytes by attachment ref (MinIO). Throws NotFoundError. */
  download: (fileUrl: string) => Promise<Buffer>;
  stt: SttConfig;
  now: () => Date;
  logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

export interface VoiceRunOptions {
  /** Don't write anything to the DB (report-only). */
  dryRun: boolean;
  /** Unmarked rows younger than this are adopted (see pendingRowsQuery). */
  adoptUnmarkedDays: number;
  /** Wait this long for the connector's async media upload before failing. */
  mediaGraceHours: number;
  maxAttempts: number;
  /**
   * Spanish-first: force 'es'; if the clip comes back empty, retry once with
   * auto-detect. Empty string disables forcing (pure auto-detect).
   */
  language: string;
}

export type VoiceOutcome =
  | { id: string; outcome: 'done'; chars: number; language: string | null }
  | { id: string; outcome: 'pending'; reason: string }
  | { id: string; outcome: 'failed'; reason: string }
  | { id: string; outcome: 'skipped'; reason: string };

function isNotFound(e: unknown): boolean {
  const code = (e as { code?: string; name?: string })?.code;
  return code === 'NotFound' || code === 'NoSuchKey' || code === 'ENOENT';
}

/**
 * Transcribe one pending voice row end to end. Never throws: every failure
 * mode is recorded on the row and returned as an outcome.
 */
export async function transcribeVoiceRow(
  deps: VoiceDeps,
  row: VoiceRow,
  opts: VoiceRunOptions
): Promise<VoiceOutcome> {
  const log = deps.logger ?? console;
  if (!opts.dryRun) await markProcessing(deps.pool, row.id);

  // 1. bytes: the attachment row is written only after the MinIO upload
  //    succeeded (baileys-client.downloadAndStoreMedia), so a missing row here
  //    means the upload is still in flight (young row → wait) or died (old row
  //    → the media is simply not recoverable).
  if (!row.attachment_id || !row.file_url) {
    const ageMs = deps.now().getTime() - new Date(row.created_at).getTime();
    if (ageMs < opts.mediaGraceHours * 3600_000) {
      await failTranscription(deps.pool, row.id, row.attempts, 'attachment_pending', {
        retry: true,
        bumpAttempts: false,
        maxAttempts: opts.maxAttempts,
        dryRun: opts.dryRun,
      });
      return { id: row.id, outcome: 'pending', reason: 'attachment_pending' };
    }
    await failTranscription(deps.pool, row.id, row.attempts, 'no_attachment', {
      retry: false,
      maxAttempts: opts.maxAttempts,
      dryRun: opts.dryRun,
    });
    return { id: row.id, outcome: 'failed', reason: 'no_attachment' };
  }

  // 2. download from MinIO
  let audio: Buffer;
  try {
    audio = await deps.download(row.file_url);
  } catch (e) {
    if (isNotFound(e)) {
      await failTranscription(deps.pool, row.id, row.attempts, 'media_not_found', {
        retry: false,
        maxAttempts: opts.maxAttempts,
        dryRun: opts.dryRun,
      });
      return { id: row.id, outcome: 'failed', reason: 'media_not_found' };
    }
    const msg = `download:${e instanceof Error ? e.message : String(e)}`;
    await failTranscription(deps.pool, row.id, row.attempts, msg, {
      retry: true,
      maxAttempts: opts.maxAttempts,
      dryRun: opts.dryRun,
    });
    return { id: row.id, outcome: 'pending', reason: msg.slice(0, 120) };
  }

  // 3. STT — Spanish first, auto-detect fallback on empty (ADR: es default).
  const file = audioFilename(row.mime_type);
  const languages = opts.language ? [opts.language, ''] : [''];
  let text = '';
  let language: string | null = null;
  let lastError: unknown = null;
  for (const lang of languages) {
    try {
      const r = await sttTranscribe(
        { ...deps.stt, language: lang || undefined },
        audio,
        file.name,
        file.type
      );
      text = r.text;
      language = r.language ?? (lang || null);
      if (text) break;
    } catch (e) {
      lastError = e;
      log.warn(`voice-transcribe: stt failed for row ${row.id}: ${String(e)}`);
      break; // transient — don't burn the auto-detect retry on a dead service
    }
  }
  if (lastError) {
    const msg = `stt:${lastError instanceof Error ? lastError.message : String(lastError)}`;
    await failTranscription(deps.pool, row.id, row.attempts, msg, {
      retry: true,
      maxAttempts: opts.maxAttempts,
      dryRun: opts.dryRun,
    });
    return { id: row.id, outcome: 'pending', reason: msg.slice(0, 120) };
  }
  if (!text) {
    await failTranscription(deps.pool, row.id, row.attempts, 'empty_transcription', {
      retry: false,
      maxAttempts: opts.maxAttempts,
      dryRun: opts.dryRun,
    });
    return { id: row.id, outcome: 'failed', reason: 'empty_transcription' };
  }

  // 4. write content + done
  await completeTranscription(deps.pool, row.id, text, language, opts.dryRun);
  return { id: row.id, outcome: 'done', chars: text.length, language };
}

export interface VoiceRowTally {
  done: number;
  pending: number;
  failed: number;
  skipped: number;
  rows: number;
}

/**
 * One bounded pass: claim pending rows in batches and transcribe them with a
 * small worker pool (the STT service is a single replica; hammering it is
 * rude). Returns the outcome tally.
 */
export async function runVoicePass(
  deps: VoiceDeps,
  opts: VoiceRunOptions & {
    account?: string;
    batch: number;
    concurrency: number;
    maxRows: number;
    maxRuntimeMs: number;
  }
): Promise<VoiceRowTally> {
  const started = deps.now().getTime();
  const tally: VoiceRowTally = { done: 0, pending: 0, failed: 0, skipped: 0, rows: 0 };
  if (!opts.dryRun) {
    const stuck = await recoverStuckProcessing(deps.pool, STUCK_CLAIM_TIMEOUT_MS);
    if (stuck) deps.logger?.info(`voice-transcribe: recovered ${stuck} stuck processing rows`);
  }
  for (;;) {
    const remaining = opts.maxRows > 0 ? opts.maxRows - tally.rows : opts.batch;
    if (remaining <= 0) break;
    if (deps.now().getTime() - started > opts.maxRuntimeMs) break;
    const { text, params } = pendingRowsQuery({
      account: opts.account,
      adoptUnmarkedSince: new Date(deps.now().getTime() - opts.adoptUnmarkedDays * 86_400_000),
      limit: Math.min(opts.batch, remaining),
      maxAttempts: opts.maxAttempts,
    });
    const res = await deps.pool.query(text, params);
    const rows = res.rows as VoiceRow[];
    if (rows.length === 0) break;
    tally.rows += rows.length;

    // small worker pool
    const queue = [...rows];
    let batchProgress = 0; // rows that left the queue (done or terminal failed)
    const workers = Array.from(
      { length: Math.max(1, Math.min(opts.concurrency, queue.length)) },
      async () => {
        for (;;) {
          const row = queue.shift();
          if (!row) return;
          try {
            const out = await transcribeVoiceRow(deps, row, opts);
            tally[out.outcome] += 1;
            if (out.outcome === 'done' || out.outcome === 'failed') batchProgress += 1;
          } catch (e) {
            // belt & braces: transcribeVoiceRow swallows known modes
            tally.failed += 1;
            batchProgress += 1;
            deps.logger?.warn(`voice-transcribe: unexpected error on row ${row.id}: ${String(e)}`);
          }
        }
      }
    );
    await Promise.all(workers);
    // No row left the queue this batch (e.g. every media upload is still in
    // flight, or the STT service is down and all retries went back to pending):
    // stop instead of re-selecting the same rows until the runtime budget dies.
    if (batchProgress === 0) break;
  }
  return tally;
}
