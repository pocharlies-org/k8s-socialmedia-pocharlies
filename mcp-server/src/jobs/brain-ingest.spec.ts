import {
  BrainIngestConfig,
  BrainPushError,
  classifyFailure,
  createConfig,
  pushToBrain,
} from './brain-ingest';

const baseConfig: BrainIngestConfig = {
  databaseUrl: 'postgresql://example',
  brainUrl: 'http://brain.local',
  brainApiKey: 'secret',
  batch: 20,
  maxRows: 1000,
  backfill: false,
  since: '1970-01-01T00:00:00Z',
  dryRun: false,
  pushRetries: 2,
  pushTimeoutMs: 50,
  pushRetryBaseDelayMs: 1,
  pushRetryMaxDelayMs: 1,
  pushConcurrency: 1,
  maxRuntimeMs: 0,
};

function response(status: number, body: Record<string, unknown> | string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    json: jest.fn().mockResolvedValue(typeof body === 'string' ? {} : body),
  } as unknown as Response;
}

describe('brain-ingest push handling', () => {
  it('classifies Brain/TEI 5xx and fetch failures as transient', () => {
    expect(classifyFailure(new BrainPushError('bad gateway', 502))).toMatchObject({
      kind: 'transient',
      status: 502,
    });
    expect(classifyFailure(new TypeError('fetch failed'))).toMatchObject({ kind: 'transient' });
    expect(
      classifyFailure(
        new Error(
          "all TEI dense endpoints failed: http://bge-m3-embedding.llm:8000: ConnectTimeout"
        )
      )
    ).toMatchObject({ kind: 'transient' });
  });

  it('classifies auth and validation responses as fatal', () => {
    expect(classifyFailure(new BrainPushError('unauthorized', 401))).toMatchObject({
      kind: 'fatal',
      status: 401,
    });
    expect(classifyFailure(new BrainPushError('bad request', 400))).toMatchObject({
      kind: 'fatal',
      status: 400,
    });
  });

  it('retries transient Brain failures and returns ingested chunks', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        response(
          502,
          '{"detail":"Ingest failed: RuntimeError(\'all TEI dense endpoints failed: ConnectTimeout\')"}'
        )
      )
      .mockResolvedValueOnce(response(200, { chunks_ingested: 3 }));

    await expect(
      pushToBrain(
        'personal',
        'whatsapp',
        [{ source_id: 'wa:1', content: 'hello', metadata: {} }],
        baseConfig,
        { fetchFn, sleep: jest.fn().mockResolvedValue(undefined) }
      )
    ).resolves.toBe(3);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry fatal Brain responses', async () => {
    const fetchFn = jest.fn().mockResolvedValue(response(401, '{"detail":"nope"}'));

    await expect(
      pushToBrain(
        'personal',
        'whatsapp',
        [{ source_id: 'wa:1', content: 'hello', metadata: {} }],
        baseConfig,
        { fetchFn, sleep: jest.fn().mockResolvedValue(undefined) }
      )
    ).rejects.toMatchObject({ status: 401 });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('aborts requests after the configured timeout', async () => {
    const fetchFn = jest.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
        })
    );

    await expect(
      pushToBrain(
        'personal',
        'whatsapp',
        [{ source_id: 'wa:1', content: 'hello', metadata: {} }],
        { ...baseConfig, pushRetries: 0, pushTimeoutMs: 1 },
        { fetchFn, sleep: jest.fn().mockResolvedValue(undefined) }
      )
    ).rejects.toThrow('AbortError');

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('parses operational tuning env vars with safe defaults', () => {
    expect(
      createConfig({
        BRAIN_PUSH_RETRIES: '3',
        BRAIN_PUSH_TIMEOUT_MS: '15000',
        BRAIN_PUSH_CONCURRENCY: '2',
        BRAIN_INGEST_MAX_RUNTIME_MS: '240000',
      })
    ).toMatchObject({
      pushRetries: 3,
      pushTimeoutMs: 15000,
      pushConcurrency: 2,
      maxRuntimeMs: 240000,
    });
  });
});
