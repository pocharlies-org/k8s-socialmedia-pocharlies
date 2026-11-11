/**
 * INFRA-364 — data-fix lib for voice-echo rows whose `content` stores the RAW
 * STT response body instead of the transcript.
 *
 * Bots that transcribe an incoming voice note echo the transcript back as a
 * TEXT message (Hermes gateway with `echo_transcripts: true`, DGX Studio).
 * When the echo embeds the raw `/v1/audio/transcriptions` body, the row lands
 * as e.g. `🎙️ "{"text":"…","usage":null}"` — marker + quoted JSON with
 * unescaped inner quotes. The ingest path now unwraps that shape
 * (connectors/telegram-sync/sync/mapping.py `unwrap_asr_json`); this lib is
 * the mirror for the historical rows, with the SAME shape rules: only content
 * that fully parses as the ASR JSON shape is rewritten, everything else —
 * prose that merely mentions JSON, marker + prose — is never touched.
 *
 * Pure functions + SQL builders so the matching/resumability rules are
 * unit-tested without a database. Entry point: voice-json-fix.ts.
 */

export const VOICE_ECHO_PREFIX = '🎙️';

/** The transcript inside a full ASR-response JSON object, or null.
 * The whole string must parse as a JSON object carrying a non-empty string
 * `text` (OpenAI-compatible json format) or — as verbose_json — a `segments`
 * array whose parts carry the text. */
export function asrTextOf(s: string): string | null {
  const t = s.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.text === 'string' && o.text.trim()) return o.text.trim();
  if (Array.isArray(o.segments)) {
    const parts = o.segments
      .map(seg =>
        seg && typeof seg === 'object' && typeof (seg as Record<string, unknown>).text === 'string'
          ? ((seg as Record<string, unknown>).text as string).trim()
          : ''
      )
      .filter(p => p);
    if (parts.length) return parts.join(' ');
  }
  return null;
}

/**
 * Unwrap an ASR echo body to `🎙️ <clean text>` (or plain text when the echo
 * carried no marker). Returns null when the content is NOT the shape — callers
 * must treat null as "never rewrite". Shapes accepted (identical to the
 * Python ingest mapper): marker + quoted raw body, raw body, and a properly
 * escaped JSON string whose value is the body.
 */
export function unwrapAsrJson(content: string): string | null {
  let rest = content.trim();
  let prefix = '';
  if (rest.startsWith(VOICE_ECHO_PREFIX)) {
    let i = VOICE_ECHO_PREFIX.length;
    while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i += 1;
    prefix = rest.slice(0, i);
    rest = rest.slice(i);
  }
  let text: string | null = null;
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
    // Observed echo shape: raw body wrapped in quotes WITHOUT escaping the
    // inner ones — strip the outer quotes and parse what is left. Fall back
    // to a properly escaped JSON string whose value is itself the body.
    text = asrTextOf(rest.slice(1, -1));
    if (text === null) {
      try {
        const inner: unknown = JSON.parse(rest);
        if (typeof inner === 'string') text = asrTextOf(inner);
      } catch {
        /* not a JSON string — not the shape */
      }
    }
  } else {
    text = asrTextOf(rest);
  }
  if (text === null) return null;
  return prefix ? `${prefix}${text}` : text;
}

export interface FixQueryOptions {
  /** Scope to one platform ('telegram'|'whatsapp'); undefined = both. */
  platform?: string;
  /** Scope to one account (personal|professional|leila); undefined = all. */
  account?: string;
}

/**
 * Census of candidate rows per platform/account for the report pass. The SQL
 * prefilter is deliberately cheap (content heads); the exact shape check runs
 * in TS through `unwrapAsrJson` before any UPDATE, so a row only counts as
 * fixable here, never gets rewritten by SQL alone.
 */
export function fixCountQuery(opts: FixQueryOptions): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  let text = `
SELECT platform, account, count(*)::int AS candidates
FROM messages
WHERE content IS NOT NULL
  AND metadata->>'transcription_fixed_at' IS NULL
  AND (content LIKE '🎙%' OR content LIKE '{%' OR content LIKE '"{%')`;
  if (opts.platform) {
    params.push(opts.platform);
    text += `\n  AND platform = $${params.length}`;
  }
  if (opts.account) {
    params.push(opts.account);
    text += `\n  AND account = $${params.length}`;
  }
  text += '\nGROUP BY platform, account\nORDER BY platform, account';
  return { text, params };
}

export interface FixCandidatesOptions extends FixQueryOptions {
  /** Keyset cursor: only rows with id > afterId (resumable walk). */
  afterId?: string;
  limit: number;
}

/**
 * Next batch of candidate rows, id-ascending. Idempotent + resumable: rows a
 * previous pass fixed carry `metadata.transcription_fixed_at` (and no longer
 * match the shape anyway), so they never come back; `afterId` lets a run walk
 * the table without re-reading what it already processed.
 */
export function fixCandidatesQuery(opts: FixCandidatesOptions): {
  text: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  let text = `
SELECT id, content
FROM messages
WHERE content IS NOT NULL
  AND metadata->>'transcription_fixed_at' IS NULL
  AND (content LIKE '🎙%' OR content LIKE '{%' OR content LIKE '"{%')`;
  if (opts.platform) {
    params.push(opts.platform);
    text += `\n  AND platform = $${params.length}`;
  }
  if (opts.account) {
    params.push(opts.account);
    text += `\n  AND account = $${params.length}`;
  }
  if (opts.afterId) {
    params.push(opts.afterId);
    text += `\n  AND id > $${params.length}`;
  }
  params.push(opts.limit);
  text += `\nORDER BY id ASC\nLIMIT $${params.length}`;
  return { text, params };
}

/**
 * Per-row optimistic update: rewrite content to the unwrapped transcript and
 * stamp the fix in metadata, ONLY while the row still holds the exact body we
 * parsed and nothing has fixed it before. A concurrent edit (Telegram echo
 * edited between SELECT and UPDATE) changes the content and the guard drops
 * the write — the next pass re-reads the new body.
 */
export const FIX_UPDATE_SQL = `
UPDATE messages
   SET content = $2,
       metadata = COALESCE(metadata, '{}'::jsonb)
         || jsonb_build_object('transcription_fixed_at', $3::text)
 WHERE id = $1
   AND content = $4
   AND metadata->>'transcription_fixed_at' IS NULL`;
