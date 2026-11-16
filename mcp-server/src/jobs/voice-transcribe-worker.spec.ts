import { parseVoicePending, handleVoiceEvent, VoicePendingPayload } from './voice-transcribe-worker';
import { VoiceDeps, VoiceRunOptions, VoiceRow } from './voice-transcribe-lib';

/** Answers the single-row SELECT with a canned row; UPDATEs succeed (claim won). */
class FakePool {
  row: unknown = null;
  async query(): Promise<{ rows: unknown[]; rowCount: number }> {
    return { rows: this.row ? [this.row] : [], rowCount: this.row ? 1 : 0 };
  }
}

function envelope(body: Partial<VoicePendingPayload> | null): Buffer {
  return Buffer.from(JSON.stringify({ endpoint: '/eventos', body, headers: {} }));
}

const NOW = new Date('2026-11-16T12:00:00Z');

function row(over: Partial<VoiceRow> = {}): VoiceRow {
  return {
    id: 'm1',
    account: 'personal',
    message_type: 'AUDIO',
    created_at: NOW,
    wa_timestamp: NOW,
    status: 'pending',
    attempts: 0,
    attachment_id: 'a1',
    file_url: 's3://bucket/voice.ogg',
    mime_type: 'audio/ogg',
    ...over,
  };
}

function deps(pool: FakePool, sttText = 'hola'): VoiceDeps {
  return {
    pool: pool as unknown as VoiceDeps['pool'],
    download: async () => Buffer.from('audio-bytes'),
    stt: {
      url: 'http://stt.test',
      timeoutMs: 1000,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ text: sttText, language: 'es' }),
      })) as unknown as typeof fetch,
    },
    now: () => NOW,
  };
}

const runOpts: VoiceRunOptions = {
  dryRun: false,
  adoptUnmarkedDays: 0,
  mediaGraceHours: 6,
  maxAttempts: 3,
  language: 'es',
};

describe('parseVoicePending', () => {
  it('unwraps the gateway outbox envelope', () => {
    const ev = parseVoicePending(
      envelope({ messageId: 'professional:m1', account: 'professional', waMessageId: 'ABC' })
    );
    expect(ev).toEqual({ messageId: 'professional:m1', account: 'professional', waMessageId: 'ABC' });
  });
  it('falls back to waMessageId when the row id is missing', () => {
    const ev = parseVoicePending(envelope({ account: 'personal', waMessageId: 'ABC' }));
    expect(ev?.messageId).toBe('ABC');
  });
  it('drops malformed bodies (no ids, non-JSON, no body)', () => {
    expect(parseVoicePending(Buffer.from('not json'))).toBeNull();
    expect(parseVoicePending(Buffer.from(JSON.stringify({ endpoint: '/eventos' })))).toBeNull();
    expect(parseVoicePending(envelope({ account: 'personal' }))).toBeNull();
  });
});

describe('handleVoiceEvent', () => {
  it('acks when the row transcribes (done)', async () => {
    const pool = new FakePool();
    pool.row = row();
    const out = await handleVoiceEvent(envelope({ messageId: 'm1', account: 'personal', waMessageId: 'ABC' }), {
      deps: deps(pool),
      runOpts,
    });
    expect(out).toBe('ack');
  });
  it('routes to retry when the media is still uploading (pending, no burn)', async () => {
    const pool = new FakePool();
    pool.row = row({ attachment_id: null, file_url: null }); // young row → attachment_pending
    const out = await handleVoiceEvent(envelope({ messageId: 'm1', account: 'personal', waMessageId: 'ABC' }), {
      deps: deps(pool),
      runOpts,
    });
    expect(out).toBe('retry');
  });
  it('acks a foreign/stale event (no matching row)', async () => {
    const pool = new FakePool();
    pool.row = null;
    const out = await handleVoiceEvent(envelope({ messageId: 'gone', account: 'personal', waMessageId: 'X' }), {
      deps: deps(pool),
      runOpts,
    });
    expect(out).toBe('ack');
  });
  it('acks a malformed event without touching the DB', async () => {
    const pool = new FakePool();
    const out = await handleVoiceEvent(Buffer.from('garbage'), { deps: deps(pool), runOpts });
    expect(out).toBe('ack');
  });
});
