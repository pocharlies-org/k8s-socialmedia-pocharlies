/**
 * DGX-1640 — voice-note event to Synapse (replaces the 5-min transcription CronJob).
 *
 * After an AUDIO/PTT row lands `transcription_status=pending`, the connector
 * publishes `eventos.whatsapp.voice.pending` through the Synapse gateway's
 * generic durable ingest (`POST /eventos`, CONTRACT http.gateway.eventos.v1):
 * the gateway writes inbox+outbox in one transaction and the dispatcher
 * publishes to the `events` exchange — so the event survives a worker being
 * down (unlike NATS at-most-once). The resident worker
 * (`mcp-server/src/jobs/voice-transcribe-worker.ts`) consumes it and calls the
 * same claim/STT/write machinery the CronJob used.
 *
 * Fail-open by design (same posture as buildAudioAttachmentsBeforeEmit): a
 * publish failure NEVER blocks ingest. The row stays `pending` and the worker's
 * startup sweep picks it up on its next restart; losing this event is never
 * losing the transcription, only its latency.
 *
 * Payload is ids only (no content, no PII beyond what the assistant stream
 * already carries). HMAC over the raw bytes, exactly once (byte-identity
 * invariant, same as the synapse bridge's gateway client).
 */
import { createHmac } from 'crypto';

/** CONTRACT: eventos.whatsapp.voice.pending — ids only; consumers key on messageId. */
export const VOICE_PENDING_ROUTING_KEY = 'eventos.whatsapp.voice.pending';

export interface VoicePendingEvent {
  /** `messages.id` (namespaced), the row marked pending. */
  messageId: string;
  /** 'personal' | 'professional' | 'leila'. */
  account: string;
  /** Raw WhatsApp message id (fallback lookup when the row id is unknown). */
  waMessageId: string;
}

export interface VoiceEventsConfig {
  /** Gateway `/eventos` ClusterIP URL, e.g. http://synapse-gateway.synapse.svc.cluster.local:8080/eventos */
  url: string;
  /** Producer name as declared in the gateway allowlist. */
  producer: string;
  /** HMAC secret (same value as the gateway's `whatsapp.webhook.secret`). */
  secret: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts for retryable failures (network/timeout/429/5xx). */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** `sha256=<hex>` over the exact bytes the gateway will verify (X-Hub-Signature-256). */
export function signEventosBody(bytes: Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(bytes).digest('hex');
}

/** Serializes ONCE; the signed bytes are the sent bytes (byte-identity invariant). */
export function buildEventosBody(ev: VoicePendingEvent): Buffer {
  return Buffer.from(
    JSON.stringify({ routing_key: VOICE_PENDING_ROUTING_KEY, ...ev }),
    'utf-8'
  );
}

export interface VoiceEventsLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * POST /eventos with bounded retry. Resolves true on 2xx, false on permanent
 * failure (4xx other than 429, or the attempt budget spent) — never throws.
 */
export async function publishVoicePending(
  cfg: VoiceEventsConfig,
  ev: VoicePendingEvent,
  logger?: VoiceEventsLogger
): Promise<boolean> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const sleep = cfg.sleep ?? defaultSleep;
  const maxAttempts = cfg.maxAttempts ?? 5;
  const base = cfg.baseDelayMs ?? 1000;
  const cap = cfg.maxDelayMs ?? 30_000;

  const body = buildEventosBody(ev);
  const signature = signEventosBody(body, cfg.secret);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retryable = false;
    try {
      const res = await doFetch(cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-synapse-producer': cfg.producer,
          'x-hub-signature-256': signature,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
      retryable = res.status === 429 || res.status >= 500;
      if (!retryable) {
        logger?.warn(
          `voice-pending event rejected ${res.status} for ${ev.messageId} (not retryable)`
        );
        return false;
      }
    } catch {
      retryable = true; // network / timeout
    }
    if (retryable && attempt < maxAttempts) {
      await sleep(Math.min(cap, base * 2 ** (attempt - 1)));
    }
  }
  logger?.warn(`voice-pending event exhausted ${maxAttempts} attempts for ${ev.messageId}`);
  return false;
}

/**
 * Env-gated fire-and-forget used by the ingest path: unconfigured (no URL or
 * secret) is a silent no-op — the pre-DGX-1640 behavior, zero new traffic.
 */
export function voiceEventsConfigFromEnv(): VoiceEventsConfig | null {
  const url = process.env.SYNAPSE_EVENTOS_URL || '';
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET || '';
  if (!url || !secret) return null;
  return {
    url,
    producer: process.env.SYNAPSE_EVENTOS_PRODUCER || 'whatsapp-voice',
    secret,
  };
}

export function publishVoicePendingBestEffort(
  cfg: VoiceEventsConfig | null,
  ev: VoicePendingEvent,
  logger?: VoiceEventsLogger
): void {
  if (!cfg) return;
  void publishVoicePending(cfg, ev, logger).catch(() => {
    /* publishVoicePending never throws; belt & braces for a bad fetchImpl */
  });
}
