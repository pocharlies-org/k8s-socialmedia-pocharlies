import {
  audioFilename,
  completeTranscription,
  failTranscription,
  parseSttResponse,
  pendingRowsQuery,
  runVoicePass,
  transcribeVoiceRow,
  VoiceRow,
  VoiceRunOptions,
  STUCK_CLAIM_TIMEOUT_MS,
} from './voice-transcribe-lib';

/** Minimal pg.Pool double: records every statement, answers SELECTs with canned rows. */
class FakePool {
  calls: { sql: string; params: unknown[] }[] = [];
  selectRows: unknown[] = [];
  selectCount = 0;
  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.calls.push({ sql, params });
    if (/^\s*SELECT/i.test(sql)) {
      this.selectCount += 1;
      // First pass returns the batch, later passes drain the queue.
      const rows = this.selectCount === 1 ? this.selectRows : [];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 1 };
  }
  updates(): { sql: string; params: unknown[] }[] {
    return this.calls.filter(c => /^\s*UPDATE/i.test(c.sql));
  }
}

const NOW = new Date('2026-10-01T12:00:00Z');

function voiceRow(over: Partial<VoiceRow> = {}): VoiceRow {
  return {
    id: '100',
    account: 'personal',
    message_type: 'AUDIO',
    created_at: new Date(NOW.getTime() - 60_000),
    wa_timestamp: new Date(NOW.getTime() - 60_000),
    status: 'pending',
    attempts: 0,
    attachment_id: '7',
    file_url: 's3://skirmshop-drive/socialmedia/attachments/100/1.bin',
    mime_type: 'audio/ogg; codecs=opus',
    ...over,
  };
}

function runOpts(over: Partial<VoiceRunOptions> = {}): VoiceRunOptions {
  return {
    dryRun: false,
    adoptUnmarkedDays: 7,
    mediaGraceHours: 6,
    maxAttempts: 3,
    language: 'es',
    ...over,
  };
}

/** fetch double: records the FormData sent per call and replies with canned JSON. */
function fakeFetch(replies: { ok: boolean; status?: number; body?: unknown }[]) {
  const seen: { fields: [string, string][]; hasFile: boolean }[] = [];
  let i = 0;
  const fn = (async (_url: string, init: RequestInit) => {
    const form = init.body as FormData;
    const fields: [string, string][] = [];
    let hasFile = false;
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') fields.push([k, v]);
      else hasFile = true;
    }
    seen.push({ fields, hasFile });
    const r = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (!r.ok) {
      return { ok: false, status: r.status ?? 500, text: async () => 'boom', json: async () => ({}) };
    }
    return { ok: true, status: 200, text: async () => '', json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fn, seen };
}

describe('pendingRowsQuery', () => {
  it('only consumes marked-pending rows when no adoption window is given', () => {
    const { text, params } = pendingRowsQuery({ limit: 10, maxAttempts: 3 });
    expect(text).toContain("m.metadata->>'transcription_status' = 'pending'");
    expect(text).not.toContain('IS NULL AND m.created_at');
    expect(text).toContain("m.message_type IN ('AUDIO','PTT')");
    expect(text).toContain("m.platform = 'whatsapp'");
    expect(text).toContain('m.is_deleted = false');
    expect(params).toEqual([3, 10]);
  });

  it('adopts unmarked rows younger than the window and scopes by account', () => {
    const since = new Date('2026-09-24T00:00:00Z');
    const { text, params } = pendingRowsQuery({
      limit: 5,
      maxAttempts: 3,
      adoptUnmarkedSince: since,
      account: 'professional',
    });
    expect(text).toContain('IS NULL AND m.created_at >= $2');
    expect(text).toContain('m.account = $3');
    expect(params).toEqual([3, since, 'professional', 5]);
  });
});

describe('audioFilename / parseSttResponse', () => {
  it('maps stored mimes to whisper-friendly names and defaults legacy .bin to ogg', () => {
    expect(audioFilename('audio/ogg; codecs=opus')).toEqual({ name: 'voice.ogg', type: 'audio/ogg' });
    expect(audioFilename('audio/mpeg')).toEqual({ name: 'voice.mp3', type: 'audio/mpeg' });
    expect(audioFilename(null)).toEqual({ name: 'voice.ogg', type: 'audio/ogg' });
  });
  it('trims text and tolerates missing fields', () => {
    expect(parseSttResponse({ text: ' hola ', language: 'es' })).toEqual({ text: 'hola', language: 'es' });
    expect(parseSttResponse({})).toEqual({ text: '', language: null });
    expect(parseSttResponse(null)).toEqual({ text: '', language: null });
  });
});

describe('transcribeVoiceRow', () => {
  it('happy path: processing → download → STT(es) → content + done', async () => {
    const pool = new FakePool();
    const { fn, seen } = fakeFetch([{ ok: true, body: { text: 'sí, llevo las muestras', language: 'es' } }]);
    const downloaded: string[] = [];
    const out = await transcribeVoiceRow(
      {
        pool: pool as never,
        download: async url => {
          downloaded.push(url);
          return Buffer.from('oggbytes');
        },
        stt: { url: 'http://stt.test:8000', timeoutMs: 1000, fetchImpl: fn },
        now: () => NOW,
      },
      voiceRow(),
      runOpts()
    );
    expect(out.outcome).toBe('done');
    expect(downloaded).toEqual([voiceRow().file_url]);
    expect(seen[0].fields).toContainEqual(['language', 'es']);
    expect(seen[0].hasFile).toBe(true);
    const updates = pool.updates();
    expect(updates[0].sql).toContain("'processing'");
    const last = updates[updates.length - 1];
    expect(last.sql).toContain('SET content = $2');
    expect(last.params[1]).toBe('sí, llevo las muestras');
    expect(JSON.parse(last.params[2] as string)).toMatchObject({
      transcription_status: 'done',
      transcription_language: 'es',
    });
  });

  it('Spanish-first: empty es result retries with auto-detect', async () => {
    const pool = new FakePool();
    const { fn, seen } = fakeFetch([
      { ok: true, body: { text: '', language: 'es' } },
      { ok: true, body: { text: 'hello there', language: 'en' } },
    ]);
    const out = await transcribeVoiceRow(
      {
        pool: pool as never,
        download: async () => Buffer.from('x'),
        stt: { url: 'http://stt.test:8000', timeoutMs: 1000, fetchImpl: fn },
        now: () => NOW,
      },
      voiceRow(),
      runOpts()
    );
    expect(out.outcome).toBe('done');
    expect(seen).toHaveLength(2);
    expect(seen[0].fields).toContainEqual(['language', 'es']);
    expect(seen[1].fields.find(([k]) => k === 'language')).toBeUndefined();
  });

  it('no attachment + young row → back to pending without burning an attempt', async () => {
    const pool = new FakePool();
    const out = await transcribeVoiceRow(
      {
        pool: pool as never,
        download: async () => Buffer.from('x'),
        stt: { url: 'http://stt.test', timeoutMs: 100, fetchImpl: fakeFetch([{ ok: true }]).fn },
        now: () => NOW,
      },
      voiceRow({ attachment_id: null, file_url: null, created_at: new Date(NOW.getTime() - 3600_000) }),
      runOpts()
    );
    expect(out).toEqual({ id: '100', outcome: 'pending', reason: 'attachment_pending' });
    const patch = JSON.parse(pool.updates().at(-1)!.params[1] as string);
    expect(patch.transcription_status).toBe('pending');
    expect(patch.transcription_attempts).toBeUndefined();
  });

  it('no attachment + old row → terminal failed no_attachment', async () => {
    const pool = new FakePool();
    const out = await transcribeVoiceRow(
      {
        pool: pool as never,
        download: async () => Buffer.from('x'),
        stt: { url: 'http://stt.test', timeoutMs: 100, fetchImpl: fakeFetch([{ ok: true }]).fn },
        now: () => NOW,
      },
      voiceRow({
        attachment_id: null,
        file_url: null,
        created_at: new Date(NOW.getTime() - 24 * 3600_000),
      }),
      runOpts()
    );
    expect(out).toEqual({ id: '100', outcome: 'failed', reason: 'no_attachment' });
    const patch = JSON.parse(pool.updates().at(-1)!.params[1] as string);
    expect(patch.transcription_status).toBe('failed');
    expect(patch.transcription_error).toBe('no_attachment');
  });

  it('missing MinIO object → terminal failed media_not_found', async () => {
    const pool = new FakePool();
    const err = Object.assign(new Error('The specified key does not exist.'), { code: 'NotFound' });
    const out = await transcribeVoiceRow(
      {
        pool: pool as never,
        download: async () => {
          throw err;
        },
        stt: { url: 'http://stt.test', timeoutMs: 100, fetchImpl: fakeFetch([{ ok: true }]).fn },
        now: () => NOW,
      },
      voiceRow(),
      runOpts()
    );
    expect(out).toEqual({ id: '100', outcome: 'failed', reason: 'media_not_found' });
  });

  it('STT outage is transient: pending + attempt burned, auto-detect not tried', async () => {
    const pool = new FakePool();
    const { fn, seen } = fakeFetch([{ ok: false, status: 503 }]);
    const out = await transcribeVoiceRow(
      {
        pool: pool as never,
        download: async () => Buffer.from('x'),
        stt: { url: 'http://stt.test', timeoutMs: 100, fetchImpl: fn },
        now: () => NOW,
      },
      voiceRow({ attempts: 1 }),
      runOpts()
    );
    expect(out.outcome).toBe('pending');
    expect(seen).toHaveLength(1);
    const patch = JSON.parse(pool.updates().at(-1)!.params[1] as string);
    expect(patch.transcription_status).toBe('pending');
    expect(patch.transcription_attempts).toBe(2);
  });

  it('attempt budget exhausted → terminal failed even for transient errors', async () => {
    const pool = new FakePool();
    const { fn } = fakeFetch([{ ok: false, status: 503 }]);
    const out = await transcribeVoiceRow(
      {
        pool: pool as never,
        download: async () => Buffer.from('x'),
        stt: { url: 'http://stt.test', timeoutMs: 100, fetchImpl: fn },
        now: () => NOW,
      },
      voiceRow({ attempts: 2 }),
      runOpts()
    );
    expect(out.outcome).toBe('pending');
    const patch = JSON.parse(pool.updates().at(-1)!.params[1] as string);
    expect(patch.transcription_status).toBe('failed');
  });

  it('empty transcription after both languages → failed empty_transcription', async () => {
    const pool = new FakePool();
    const { fn } = fakeFetch([{ ok: true, body: { text: '  ' } }]);
    const out = await transcribeVoiceRow(
      {
        pool: pool as never,
        download: async () => Buffer.from('x'),
        stt: { url: 'http://stt.test', timeoutMs: 100, fetchImpl: fn },
        now: () => NOW,
      },
      voiceRow(),
      runOpts()
    );
    expect(out).toEqual({ id: '100', outcome: 'failed', reason: 'empty_transcription' });
  });

  it('dry-run writes nothing to the DB', async () => {
    const pool = new FakePool();
    const { fn } = fakeFetch([{ ok: true, body: { text: 'hola', language: 'es' } }]);
    const out = await transcribeVoiceRow(
      {
        pool: pool as never,
        download: async () => Buffer.from('x'),
        stt: { url: 'http://stt.test', timeoutMs: 100, fetchImpl: fn },
        now: () => NOW,
      },
      voiceRow(),
      runOpts({ dryRun: true })
    );
    expect(out.outcome).toBe('done');
    expect(pool.calls).toHaveLength(0);
  });
});

describe('complete/fail primitives', () => {
  it('completeTranscription guards against overwriting a done row', async () => {
    const pool = new FakePool();
    await completeTranscription(pool as never, '9', 'texto', 'es');
    expect(pool.calls[0].sql).toContain("COALESCE(metadata->>'transcription_status', 'pending') <> 'done'");
  });
  it('failTranscription truncates long errors', async () => {
    const pool = new FakePool();
    await failTranscription(pool as never, '9', 0, 'x'.repeat(900), {
      retry: false,
      maxAttempts: 3,
    });
    const patch = JSON.parse(pool.calls[0].params[1] as string);
    expect(patch.transcription_error.length).toBeLessThanOrEqual(500);
  });
});

describe('runVoicePass', () => {
  it('drains the queue and tallies outcomes', async () => {
    const pool = new FakePool();
    pool.selectRows = [
      voiceRow({ id: '1' }),
      voiceRow({ id: '2', attachment_id: null, file_url: null, created_at: new Date(NOW.getTime() - 48 * 3600_000) }),
    ];
    const { fn } = fakeFetch([{ ok: true, body: { text: 'hola', language: 'es' } }]);
    const tally = await runVoicePass(
      {
        pool: pool as never,
        download: async () => Buffer.from('x'),
        stt: { url: 'http://stt.test', timeoutMs: 100, fetchImpl: fn },
        now: () => NOW,
      },
      {
        ...runOpts(),
        batch: 10,
        concurrency: 2,
        maxRows: 0,
        maxRuntimeMs: 60_000,
      }
    );
    expect(tally.rows).toBe(2);
    expect(tally.done).toBe(1);
    expect(tally.failed).toBe(1);
    expect(STUCK_CLAIM_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('respects the maxRows cap', async () => {
    const pool = new FakePool();
    pool.selectRows = [voiceRow({ id: '1' })];
    const { fn } = fakeFetch([{ ok: true, body: { text: 'hola' } }]);
    const tally = await runVoicePass(
      {
        pool: pool as never,
        download: async () => Buffer.from('x'),
        stt: { url: 'http://stt.test', timeoutMs: 100, fetchImpl: fn },
        now: () => NOW,
      },
      { ...runOpts(), batch: 10, concurrency: 1, maxRows: 1, maxRuntimeMs: 60_000 }
    );
    expect(tally.rows).toBe(1);
    expect(tally.done).toBe(1);
  });
});
