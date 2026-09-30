/**
 * INFRA-368 (P2): WhatsApp voice-note transcription. Pure-ish helpers, with the
 * HTTP client and the DB client injected so the spec can mock both.
 */
import type { Pool, PoolClient } from 'pg';

export const STT_MODEL = 'openai/whisper-large-v3-turbo';
export const MAX_ATTEMPTS = 3;
export const STT_TIMEOUT_MS = 60_000;

export interface Candidate {
  id: string;
  account: string;
  conversation_id: string;
  wa_message_id: string;
}

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<Response>;

/** Audio with no text yet, not retried out, keyset on messages.id. */
export const CANDIDATE_WHERE = `m.platform = 'whatsapp'
  AND m.message_type = 'AUDIO'
  AND m.is_deleted = false
  AND btrim(coalesce(m.content, '')) = ''
  AND coalesce((m.metadata->>'transcription_attempts')::int, 0) < ${MAX_ATTEMPTS}`;

/** Count used by DRY_RUN before/after and by the criterion-1 check. */
export const COUNT_SQL = `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id))::int AS with_attachment,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id))::int AS without_attachment
  FROM messages m WHERE ${CANDIDATE_WHERE}`;

export const SELECT_SQL = `SELECT m.id::text AS id, m.account, m.conversation_id, m.wa_message_id,
       EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachment
  FROM messages m
 WHERE ${CANDIDATE_WHERE} AND m.id > $1::bigint
 ORDER BY m.id ASC LIMIT $2`;

export class SttError extends Error {}

/** True when the error/status should fall over to omnivoice-audio. */
function retryable(status: number | null): boolean {
  return status === null || status >= 500;
}

/**
 * Transcribe one audio. stt-turbo first (`/v1/audio/transcriptions`); on 5xx,
 * timeout or network error, relay once to `omnivoice-audio /audio/transcribe`.
 * 4xx does not relay (the audio itself is bad).
 */
export async function transcribe(
  fetchImpl: FetchLike,
  cfg: { sttBaseUrl: string; fallbackUrl?: string },
  audio: Buffer,
  mime: string,
  filename: string
): Promise<{ text: string; model: string }> {
  const form = (withModel: boolean) => {
    const f = new FormData();
    f.append('file', new Blob([audio], { type: mime }), filename);
    if (withModel) f.append('model', STT_MODEL);
    return f;
  };
  let status: number | null = null;
  try {
    const r = await fetchImpl(`${cfg.sttBaseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form(true),
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
    status = r.status;
    if (r.ok) {
      const body = (await r.json()) as { text?: string };
      return { text: (body.text || '').trim(), model: STT_MODEL };
    }
  } catch {
    status = null;
  }
  if (!retryable(status) || !cfg.fallbackUrl) {
    throw new SttError(`stt_http_${status ?? 'error'}`);
  }
  try {
    const r = await fetchImpl(`${cfg.fallbackUrl}/audio/transcribe`, {
      method: 'POST',
      body: form(false),
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
    if (!r.ok) throw new SttError(`fallback_http_${r.status}`);
    const body = (await r.json()) as { text?: string; asr_backend?: string };
    return { text: (body.text || '').trim(), model: body.asr_backend || 'omnivoice-audio' };
  } catch (e) {
    throw e instanceof SttError ? e : new SttError('fallback_error');
  }
}

/**
 * UPDATE + INSERT into brain_window_dirty in ONE transaction: both or neither.
 * The `btrim(content)=''` guard makes a re-run / a race with a live transcript
 * a no-op (and then no dirty row is written). Returns whether it wrote.
 */
export async function writeTranscription(
  pool: Pick<Pool, 'connect'>,
  c: Candidate,
  text: string,
  model: string
): Promise<boolean> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(
      `UPDATE messages SET content = $2::text,
              metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                'transcription_status', 'done',
                'transcribed_at', now()::text,
                'transcription_model', $3::text)
        WHERE id = $1::bigint AND btrim(coalesce(content, '')) = ''`,
      [c.id, text, model]
    );
    if (u.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO brain_window_dirty (account, conversation_id, reason)
       VALUES ($1, $2, 'voice_transcribed')`,
      [c.account, c.conversation_id]
    );
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function markFailed(
  pool: Pick<Pool, 'query'>,
  id: string,
  error: string,
  finalFailure: boolean
): Promise<void> {
  await pool.query(
    `UPDATE messages SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'transcription_status', 'failed',
        'transcription_error', $2::text,
        'transcription_attempts', ${finalFailure ? String(MAX_ATTEMPTS) : `(coalesce((metadata->>'transcription_attempts')::int, 0) + 1)`})
      WHERE id = $1::bigint`,
    [id, error]
  );
}
