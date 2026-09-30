/**
 * INFRA-368 (P2): transcribes WhatsApp voice notes that have an attachment but
 * no text, so the conversation-window builder sees their words. DRY_RUN=true
 * (default) writes nothing: prints count before/after and transcribes up to
 * SAMPLE audios only to print them.
 */
import { Pool } from 'pg';
import pino from 'pino';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { whatsappConnectorUrl } from '../infrastructure/connector-urls';
import {
  COUNT_SQL,
  SELECT_SQL,
  Candidate,
  FetchLike,
  markFailed,
  transcribe,
  writeTranscription,
} from './wa-voice-transcribe-lib';

const logger = pino();
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is unset: refusing to start wa-voice-transcribe');
const DRY_RUN = process.env.DRY_RUN !== 'false';
const SAMPLE = parseInt(process.env.DRY_RUN_SAMPLE || '3', 10);
const BATCH = parseInt(process.env.WA_VOICE_BATCH || '50', 10);
const MAX_ROWS = parseInt(process.env.WA_VOICE_MAX_ROWS || '500', 10);
const STT_BASE_URL =
  process.env.STT_BASE_URL || 'http://stt-turbo.llm.svc.cluster.local:8000';
const STT_FALLBACK_URL = process.env.STT_FALLBACK_URL || '';
const SECRET: string = (() => {
  const v = process.env.CONNECTOR_SHARED_SECRET;
  if (!v) throw new Error('CONNECTOR_SHARED_SECRET is unset: refusing to start wa-voice-transcribe');
  return v;
})();

async function downloadAudio(c: Candidate): Promise<{ audio: Buffer; mime: string; filename: string }> {
  const base = whatsappConnectorUrl(c.account);
  if (!base) throw new Error('no_connector');
  const ts = Math.floor(Date.now() / 1000);
  // The connector verifies HMAC over `${ts}:${JSON.stringify(req.body)}`; a GET has body {}.
  const sig = generateHMACSignature({}, ts, SECRET);
  const r = await fetch(
    `${base}/api/v1/messages/media/${encodeURIComponent(c.conversation_id)}/${encodeURIComponent(c.id)}`,
    {
      headers: { 'X-Connector-Signature': sig, 'X-Connector-Timestamp': String(ts) },
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (r.status === 404) throw new Error('no_media');
  if (!r.ok) throw new Error(`connector_${r.status}`);
  const j = (await r.json()) as { data: string; mimetype: string; filename: string };
  return { audio: Buffer.from(j.data, 'base64'), mime: j.mimetype, filename: j.filename };
}

async function counts(pool: Pool) {
  return (await pool.query(COUNT_SQL)).rows[0];
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const lock = await pool.query(`SELECT pg_try_advisory_lock(hashtext('wa-voice-transcribe')) AS ok`);
  if (!lock.rows[0].ok) {
    logger.info('wa-voice-transcribe: another run holds the lock; exit 0');
    return;
  }
  const before = await counts(pool);
  logger.info({ before, DRY_RUN }, 'wa-voice-transcribe: candidates before');
  const fetchImpl = fetch as unknown as FetchLike;
  let cursor = '0';
  let done = 0;
  let sampled = 0;
  let failed = 0;
  while (done + failed < (DRY_RUN ? SAMPLE : MAX_ROWS)) {
    const rows = (await pool.query(SELECT_SQL, [cursor, BATCH])).rows as Array<
      Candidate & { has_attachment: boolean }
    >;
    if (rows.length === 0) break;
    for (const c of rows) {
      cursor = c.id;
      if (DRY_RUN && sampled >= SAMPLE) break;
      if (!c.has_attachment) {
        if (!DRY_RUN) await markFailed(pool, c.id, 'no_attachment', true);
        failed++;
        continue;
      }
      try {
        const a = await downloadAudio(c);
        const t = await transcribe(fetchImpl, { sttBaseUrl: STT_BASE_URL, fallbackUrl: STT_FALLBACK_URL }, a.audio, a.mime, a.filename);
        if (DRY_RUN) {
          sampled++;
          logger.info({ id: c.id, account: c.account, text: t.text.slice(0, 200) }, 'DRY_RUN sample (not written)');
        } else if (t.text && (await writeTranscription(pool, c, t.text, t.model))) {
          done++;
        } else {
          await markFailed(pool, c.id, t.text ? 'already_has_text' : 'empty_transcript', false);
          failed++;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn({ id: c.id, err: msg }, 'transcription failed (soft)');
        if (!DRY_RUN) await markFailed(pool, c.id, msg, false);
        failed++;
      }
      if (DRY_RUN && sampled >= SAMPLE) break;
    }
    if (DRY_RUN && sampled >= SAMPLE) break;
  }
  const after = await counts(pool);
  logger.info({ before, after, done, failed, DRY_RUN }, 'wa-voice-transcribe: finished');
  await pool.query(`SELECT pg_advisory_unlock(hashtext('wa-voice-transcribe'))`);
  await pool.end();
}

main().catch(e => {
  // Soft failure: next */30 pass retries (attempts are capped per message).
  logger.error({ err: String(e) }, 'wa-voice-transcribe: aborted');
  process.exit(0);
});
