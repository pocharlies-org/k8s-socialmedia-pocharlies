import {
  CANDIDATE_WHERE,
  SELECT_SQL,
  STT_MODEL,
  SttError,
  FetchLike,
  markFailed,
  transcribe,
  writeTranscription,
} from './wa-voice-transcribe-lib';

const res = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const cfg = { sttBaseUrl: 'http://stt', fallbackUrl: 'http://omni' };
const audio = Buffer.from('abc');

describe('selector', () => {
  it('selects WhatsApp AUDIO, undeleted, without text, under the attempts cap, keyset on id', () => {
    expect(CANDIDATE_WHERE).toContain("m.platform = 'whatsapp'");
    expect(CANDIDATE_WHERE).toContain("m.message_type = 'AUDIO'");
    expect(CANDIDATE_WHERE).toContain('m.is_deleted = false');
    expect(CANDIDATE_WHERE).toContain("btrim(coalesce(m.content, '')) = ''");
    expect(CANDIDATE_WHERE).toContain('< 3');
    expect(SELECT_SQL).toContain('m.id > $1::bigint');
    expect(SELECT_SQL).toContain('ORDER BY m.id ASC');
  });
});

describe('transcribe relay', () => {
  it('uses stt-turbo when it answers', async () => {
    const f = jest.fn().mockResolvedValue(res(200, { text: ' hola ' }));
    const r = await transcribe(f as unknown as FetchLike, cfg, audio, 'audio/ogg', 'a.ogg');
    expect(r).toEqual({ text: 'hola', model: STT_MODEL });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe('http://stt/v1/audio/transcriptions');
  });
  it('relays to omnivoice-audio on 5xx', async () => {
    const f = jest
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200, { text: 'adios', asr_backend: 'omni-asr' }));
    const r = await transcribe(f as unknown as FetchLike, cfg, audio, 'audio/ogg', 'a.ogg');
    expect(r).toEqual({ text: 'adios', model: 'omni-asr' });
    expect(f.mock.calls[1][0]).toBe('http://omni/audio/transcribe');
  });
  it('relays on timeout / network error', async () => {
    const f = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(res(200, { text: 'x' }));
    const r = await transcribe(f as unknown as FetchLike, cfg, audio, 'audio/ogg', 'a.ogg');
    expect(r.text).toBe('x');
  });
  it('does not relay on 4xx', async () => {
    const f = jest.fn().mockResolvedValue(res(400));
    await expect(transcribe(f as unknown as FetchLike, cfg, audio, 'a/b', 'a')).rejects.toThrow(SttError);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('fails when both backends fail', async () => {
    const f = jest.fn().mockResolvedValue(res(502));
    await expect(transcribe(f as unknown as FetchLike, cfg, audio, 'a/b', 'a')).rejects.toThrow('fallback_http_502');
  });
});

function fakePool(opts: { updateRows?: number; failOn?: 'insert' } = {}) {
  const log: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      const k = sql.trim().split(/\s+/)[0];
      log.push(k);
      if (k === 'UPDATE') return { rowCount: opts.updateRows ?? 1 };
      if (k === 'INSERT' && opts.failOn === 'insert') throw new Error('insert boom');
      return { rowCount: 0 };
    }),
    release: jest.fn(),
  };
  return { pool: { connect: async () => client } as never, log, client };
}
const cand = { id: '10', account: 'personal', conversation_id: 'c1', wa_message_id: 'w' };

describe('writeTranscription transaction', () => {
  it('UPDATE and INSERT dirty happen together and commit', async () => {
    const { pool, log } = fakePool();
    expect(await writeTranscription(pool, cand, 'hola', 'm')).toBe(true);
    expect(log).toEqual(['BEGIN', 'UPDATE', 'INSERT', 'COMMIT']);
  });
  it('rolls back (no COMMIT) when the INSERT fails: neither persists', async () => {
    const { pool, log } = fakePool({ failOn: 'insert' });
    await expect(writeTranscription(pool, cand, 'hola', 'm')).rejects.toThrow('insert boom');
    expect(log).toEqual(['BEGIN', 'UPDATE', 'INSERT', 'ROLLBACK']);
    expect(log).not.toContain('COMMIT');
  });
  it('no-op without dirty row when the message already has text', async () => {
    const { pool, log } = fakePool({ updateRows: 0 });
    expect(await writeTranscription(pool, cand, 'hola', 'm')).toBe(false);
    expect(log).toEqual(['BEGIN', 'UPDATE', 'ROLLBACK']);
  });
});

describe('markFailed', () => {
  it('final failure pins attempts at the cap; soft failure increments', async () => {
    const q = jest.fn().mockResolvedValue({});
    await markFailed({ query: q } as never, '1', 'no_attachment', true);
    expect(q.mock.calls[0][0]).toContain("'transcription_attempts', 3");
    await markFailed({ query: q } as never, '1', 'x', false);
    expect(q.mock.calls[1][0]).toContain('+ 1');
  });
});
