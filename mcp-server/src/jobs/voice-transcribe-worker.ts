/**
 * DGX-1640 — resident WhatsApp voice-note transcription worker (event-driven).
 *
 * Replaces the `whatsapp-voice-transcribe` CronJob (5-min poll). The connector
 * publishes `eventos.whatsapp.voice.pending` through the Synapse gateway's
 * durable outbox; this worker consumes it from the `events` exchange and runs
 * the SAME claim/STT/write machinery as the old pass (`voice-transcribe-lib`),
 * so behavior is byte-for-byte the transcription — only the trigger changed,
 * from a clock to an event (rules: events, never polling).
 *
 * Delivery model:
 *   - The gateway outbox is transactional, so a voice note is never lost while
 *     this worker is down: the durable queue holds it until we connect.
 *   - done / failed / skipped → ack.
 *   - transient (STT down, media still uploading) → the row is already back to
 *     `pending` (attempt burned or waiting), so we ack the event and republish
 *     it to a short-TTL retry queue whose DLX routes it back to this queue. The
 *     delivery slot is freed (no hot loop, no head-of-line block); the attempt
 *     budget in the row caps the retries exactly as the cron did.
 *
 * Env (same names as the old CronJob, plus the bus):
 *   DATABASE_URL        required (SC-1239 C2: no fallback)
 *   RABBITMQ_URL        required (amqp://…@shared-rabbitmq…/%2Fsynapse)
 *   VOICE_STT_URL       default http://stt-turbo.llm.svc.cluster.local:8000
 *   VOICE_LANGUAGE      default 'es'
 *   VOICE_MAX_ATTEMPTS  default 3
 *   VOICE_MEDIA_GRACE_HOURS default 6
 *   VOICE_STT_TIMEOUT_MS    default 120000
 *   VOICE_RETRY_DELAY_MS    retry-queue TTL, default 30000
 *   VOICE_QUEUE / VOICE_RETRY_QUEUE  queue names (defaults below)
 *   S3_* / LEGACY_MINIO_* / MINIO_*  media storage (same as the mcp-server)
 */
import * as amqp from 'amqplib';
import pino from 'pino';
import {
  VoiceDeps,
  VoiceRunOptions,
  buildVoiceDeps,
  selectVoiceRowById,
  transcribeVoiceRow,
} from './voice-transcribe-lib';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

export const VOICE_EVENTS_EXCHANGE = 'events';
// CONTRACT: eventos.whatsapp.voice.pending — published by the connector, consumed here.
export const VOICE_PENDING_ROUTING_KEY = 'eventos.whatsapp.voice.pending';
// CONTRACT: voice-transcribe — durable queue bound to the routing key above (prefetch 1).
export const VOICE_QUEUE = 'voice-transcribe';
export const VOICE_RETRY_QUEUE = 'voice-transcribe.retry';

/** The gateway outbox envelope: {endpoint, body, headers}; body is the connector JSON. */
export interface VoicePendingPayload {
  messageId: string;
  account: string;
  waMessageId: string;
}

/** Unwrap the outbox envelope to the connector's event. null on any malformed shape. */
export function parseVoicePending(content: Buffer): VoicePendingPayload | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(content.toString('utf-8'));
  } catch {
    return null;
  }
  const body = (envelope as { body?: unknown })?.body;
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const messageId = typeof b.messageId === 'string' ? b.messageId : '';
  const waMessageId = typeof b.waMessageId === 'string' ? b.waMessageId : '';
  const account = typeof b.account === 'string' ? b.account : '';
  if (!messageId && !waMessageId) return null;
  return { messageId: messageId || waMessageId, account, waMessageId: waMessageId || messageId };
}

export interface WorkerDeps {
  deps: VoiceDeps;
  runOpts: VoiceRunOptions;
}

/**
 * Handle one delivery. Returns the disposition so the caller acks/republishes.
 * Never throws: transcribeVoiceRow swallows every known failure mode.
 */
export async function handleVoiceEvent(
  content: Buffer,
  { deps, runOpts }: WorkerDeps
): Promise<'ack' | 'retry'> {
  const ev = parseVoicePending(content);
  if (!ev) {
    logger.warn('voice-worker: dropping malformed event');
    return 'ack';
  }
  const row = await selectVoiceRowById(deps.pool, ev.messageId, ev.waMessageId);
  if (!row) {
    // No live AUDIO/PTT row matches (foreign/stale event): nothing to do.
    return 'ack';
  }
  const out = await transcribeVoiceRow(deps, row, runOpts);
  return out.outcome === 'pending' ? 'retry' : 'ack';
}

export async function main(): Promise<void> {
  const RABBITMQ_URL = process.env.RABBITMQ_URL;
  if (!RABBITMQ_URL) {
    throw new Error('RABBITMQ_URL is unset: the voice worker is event-driven, it needs the bus');
  }

  const { pool, deps } = buildVoiceDeps(logger);
  const runOpts: VoiceRunOptions = {
    dryRun: false,
    adoptUnmarkedDays: 0, // events name the row; no adoption window needed
    mediaGraceHours: parseFloat(process.env.VOICE_MEDIA_GRACE_HOURS || '6'),
    maxAttempts: parseInt(process.env.VOICE_MAX_ATTEMPTS || '3', 10),
    language: process.env.VOICE_LANGUAGE ?? 'es',
  };

  const queue = process.env.VOICE_QUEUE || VOICE_QUEUE;
  const retryQueue = process.env.VOICE_RETRY_QUEUE || VOICE_RETRY_QUEUE;
  const retryDelayMs = parseInt(process.env.VOICE_RETRY_DELAY_MS || '30000', 10);

  const conn = await amqp.connect(RABBITMQ_URL);
  conn.on('error', e => logger.error({ err: e }, 'voice-worker: amqp connection error'));
  const ch = await conn.createChannel();
  ch.on('error', e => logger.error({ err: e }, 'voice-worker: amqp channel error'));

  // The `events` topic exchange is owned by Synapse; assert (idempotent, same
  // type) so a fresh vhost doesn't fail the bind. Never delete/rename it.
  await ch.assertExchange(VOICE_EVENTS_EXCHANGE, 'topic', { durable: true });
  await ch.assertQueue(queue, { durable: true });
  await ch.bindQueue(queue, VOICE_EVENTS_EXCHANGE, VOICE_PENDING_ROUTING_KEY);
  // Retry queue: short TTL, dead-letters back to the main queue by name (default
  // exchange). Frees the delivery slot instead of requeueing hot.
  await ch.assertQueue(retryQueue, {
    durable: true,
    arguments: { 'x-message-ttl': retryDelayMs, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': queue },
  });

  await ch.prefetch(1);
  await ch.consume(queue, async msg => {
    if (!msg) return;
    try {
      const disposition = await handleVoiceEvent(msg.content, { deps, runOpts });
      if (disposition === 'retry') {
        ch.publish('', retryQueue, msg.content, { persistent: true, contentType: 'application/json' });
        ch.ack(msg);
      } else {
        ch.ack(msg);
      }
    } catch (e) {
      // Unexpected (DB unreachable, etc.): requeue after the same retry path so
      // we neither lose the event nor hot-loop.
      logger.error({ err: e }, 'voice-worker: handler threw, routing to retry');
      ch.publish('', retryQueue, msg.content, { persistent: true, contentType: 'application/json' });
      ch.ack(msg);
    }
  });

  logger.info({ queue, retryQueue }, 'voice-worker: consuming eventos.whatsapp.voice.pending');

  const shutdown = async () => {
    logger.info('voice-worker: shutting down');
    await ch.close().catch(() => undefined);
    await conn.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch(e => {
    logger.error({ err: e }, 'voice-worker crashed');
    process.exit(1);
  });
}
