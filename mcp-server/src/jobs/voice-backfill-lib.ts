/**
 * SQL builders for the historical WhatsApp voice backfill (INFRA-364 fase 0).
 * Pure functions so the marking/resumability rules are unit-tested without a
 * database. See voice-backfill.ts for the entry point and the contract.
 */

export interface BackfillMarkOptions {
  account?: string;
  /** Cap rows marked per run (0/undefined = all). Lets the run be staged. */
  maxRows?: number;
}

const VOICE_EMPTY_WHERE = `m.platform = 'whatsapp'
    AND m.is_deleted = false
    AND m.message_type IN ('AUDIO','PTT')
    AND btrim(COALESCE(m.content,'')) = ''`;

/**
 * Per-account census of voice rows still without content: how many have a
 * stored AUDIO/PTT attachment (recoverable — the bytes are in MinIO) and how
 * many are already in each transcription state.
 */
export function backfillReportQuery(account?: string): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  let accountFilter = '';
  if (account) {
    params.push(account);
    accountFilter = `AND m.account = $${params.length}`;
  }
  const text = `
SELECT m.account,
       count(*)::int AS total,
       count(*) FILTER (WHERE a.id IS NOT NULL)::int AS with_bytes,
       count(*) FILTER (WHERE m.metadata->>'transcription_status' = 'done')::int AS done,
       count(*) FILTER (WHERE m.metadata->>'transcription_status' = 'failed')::int AS failed,
       count(*) FILTER (WHERE m.metadata->>'transcription_status' IN ('pending','processing'))::int AS queued,
       count(*) FILTER (WHERE m.metadata->>'transcription_status' IS NULL)::int AS unmarked,
       count(*) FILTER (WHERE m.metadata->>'transcription_status' IS NULL
                         AND a.id IS NOT NULL)::int AS recoverable
FROM messages m
LEFT JOIN LATERAL (
  SELECT id FROM attachments
   WHERE message_id = m.id AND file_type IN ('AUDIO','PTT')
   ORDER BY id DESC LIMIT 1
) a ON TRUE
WHERE ${VOICE_EMPTY_WHERE}
  ${accountFilter}
GROUP BY m.account
ORDER BY m.account`;
  return { text, params };
}

/**
 * Mark never-touched voice rows as `pending` — the ONLY way historical rows
 * enter the queue (the live CronJob adopts just the last few days).
 *
 * Idempotent + resumable: the WHERE clause matches rows whose
 * transcription_status IS NULL, so re-running never re-queues done/failed/
 * pending rows, and a crashed run leaves the already-marked ones queued.
 * Oldest messages first; `maxRows` stages the marking.
 */
export function backfillMarkQuery(opts: BackfillMarkOptions): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  let accountFilter = '';
  if (opts.account) {
    params.push(opts.account);
    accountFilter = `AND m.account = $${params.length}`;
  }
  let limitFilter = '';
  if (opts.maxRows && opts.maxRows > 0) {
    params.push(opts.maxRows);
    limitFilter = `LIMIT $${params.length}`;
  }
  const text = `
UPDATE messages
   SET metadata = COALESCE(metadata, '{}'::jsonb) ||
         '{"needs_transcription": true, "transcription_status": "pending", "transcription_attempts": 0}'::jsonb
 WHERE id IN (
   SELECT m.id FROM messages m
    WHERE ${VOICE_EMPTY_WHERE}
      AND m.metadata->>'transcription_status' IS NULL
      ${accountFilter}
    ORDER BY m.wa_timestamp ASC, m.id ASC
    ${limitFilter}
 )`;
  return { text, params };
}

/** Count of rows backfillMarkQuery would touch (for the DRY_RUN report). */
export function backfillCountQuery(account?: string): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  let accountFilter = '';
  if (account) {
    params.push(account);
    accountFilter = `AND m.account = $${params.length}`;
  }
  const text = `
SELECT count(*)::int AS n FROM messages m
 WHERE ${VOICE_EMPTY_WHERE}
   AND m.metadata->>'transcription_status' IS NULL
   ${accountFilter}`;
  return { text, params };
}
