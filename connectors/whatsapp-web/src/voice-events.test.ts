/**
 * Tests for the DGX-1640 voice-pending Synapse publisher (voice-events.ts).
 *
 * Contract under test:
 *   1. buildEventosBody carries routing_key + the three ids; signEventosBody is
 *      `sha256=<hex>` over the EXACT bytes sent (byte-identity invariant).
 *   2. publishVoicePending: 2xx ⇒ true; 5xx then 2xx ⇒ retries and returns true;
 *      permanent 4xx ⇒ false without burning the budget; exhausted ⇒ false.
 *   3. It NEVER throws (fail-open: a dead gateway must not block ingest).
 *   4. voiceEventsConfigFromEnv: unconfigured ⇒ null (silent no-op path).
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'crypto';
import {
  buildEventosBody,
  signEventosBody,
  publishVoicePending,
  voiceEventsConfigFromEnv,
  VoiceEventsConfig,
  VoicePendingEvent,
} from './voice-events';

const EV: VoicePendingEvent = {
  messageId: 'professional:m1',
  account: 'professional',
  waMessageId: 'ABC123',
};

test('buildEventosBody carries routing_key and the three ids', () => {
  const body = JSON.parse(buildEventosBody(EV).toString('utf-8'));
  assert.equal(body.routing_key, 'eventos.whatsapp.voice.pending');
  assert.equal(body.messageId, 'professional:m1');
  assert.equal(body.account, 'professional');
  assert.equal(body.waMessageId, 'ABC123');
});

test('signEventosBody is sha256=<hex> over the exact bytes', () => {
  const bytes = buildEventosBody(EV);
  const expected = 'sha256=' + createHmac('sha256', 's3cr3t').update(bytes).digest('hex');
  assert.equal(signEventosBody(bytes, 's3cr3t'), expected);
});

function cfgWith(responses: Array<{ status: number }>): { cfg: VoiceEventsConfig; calls: number } {
  const state = { calls: 0 };
  const cfg: VoiceEventsConfig = {
    url: 'http://gateway.test/eventos',
    producer: 'whatsapp-voice',
    secret: 's3cr3t',
    maxAttempts: 5,
    baseDelayMs: 0,
    sleep: async () => {},
    fetchImpl: (async () => {
      const r = responses[Math.min(state.calls, responses.length - 1)];
      state.calls += 1;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => '' };
    }) as unknown as typeof fetch,
  };
  return { cfg, calls: state.calls };
}

test('publishVoicePending: 2xx returns true on the first attempt', async () => {
  const { cfg } = cfgWith([{ status: 202 }]);
  assert.equal(await publishVoicePending(cfg, EV), true);
});

test('publishVoicePending: 5xx then 2xx retries and succeeds', async () => {
  const { cfg } = cfgWith([{ status: 503 }, { status: 202 }]);
  assert.equal(await publishVoicePending(cfg, EV), true);
});

test('publishVoicePending: permanent 4xx returns false without exhausting', async () => {
  const { cfg } = cfgWith([{ status: 403 }]);
  assert.equal(await publishVoicePending(cfg, EV), false);
});

test('publishVoicePending: network error never throws, returns false when exhausted', async () => {
  const cfg: VoiceEventsConfig = {
    url: 'http://gateway.test/eventos',
    producer: 'whatsapp-voice',
    secret: 's3cr3t',
    maxAttempts: 2,
    baseDelayMs: 0,
    sleep: async () => {},
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch,
  };
  assert.equal(await publishVoicePending(cfg, EV), false);
});

test('voiceEventsConfigFromEnv: unconfigured ⇒ null', () => {
  const savedUrl = process.env.SYNAPSE_EVENTOS_URL;
  const savedSecret = process.env.WHATSAPP_WEBHOOK_SECRET;
  delete process.env.SYNAPSE_EVENTOS_URL;
  process.env.WHATSAPP_WEBHOOK_SECRET = 'x';
  try {
    assert.equal(voiceEventsConfigFromEnv(), null);
  } finally {
    if (savedUrl !== undefined) process.env.SYNAPSE_EVENTOS_URL = savedUrl;
    if (savedSecret !== undefined) process.env.WHATSAPP_WEBHOOK_SECRET = savedSecret;
    else delete process.env.WHATSAPP_WEBHOOK_SECRET;
  }
});
