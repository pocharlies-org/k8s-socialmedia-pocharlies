import { Pool } from 'pg';
import { EmbeddingService, MessageChunk } from './embedding.service';
import { LlamaEmbeddingService } from './llama-embedding.service';
import { LlamaService } from './llama.service';
import { encryptString } from '@mcp-socialmedia/shared';

const create = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn(() => ({ embeddings: { create } })),
}));
jest.mock('pino', () => ({
  __esModule: true,
  default: () => ({ info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
  jest.clearAllMocks();
  create.mockReset();
});

test.each(['EMBEDDING_DIMENSION', 'EMBEDDING_DIMENSIONS'])(
  '%s selects the configured model and vector width for writes',
  async dimensionVariable => {
    delete process.env.EMBEDDING_DIMENSIONS;
    delete process.env.EMBEDDING_DIMENSION;
    process.env[dimensionVariable] = '2';
    process.env.EMBEDDING_MODEL = 'configured-model';
    create.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const db = { query } as unknown as Pool;
    const writer = new EmbeddingService('key', db, '');
    const chunks = await writer.generateEmbeddings([
      { messageId: '1', chunkIndex: 0, content: 'text' },
    ]);
    await writer.storeEmbeddings(chunks);
    for (const [request] of create.mock.calls) {
      expect(request).toMatchObject({ model: 'configured-model', encoding_format: 'float' });
    }
    expect(query.mock.calls[0][1]).toEqual(['1', '[0.1,0.2]', 'configured-model']);
    expect(create).toHaveBeenCalledTimes(1);
  }
);

test('a model returning the wrong width cannot persist an incompatible message vector', async () => {
  process.env.EMBEDDING_DIMENSIONS = '2';
  create.mockResolvedValue({ data: [{ embedding: [0.1] }] });
  const query = jest
    .fn()
    .mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          content: 'text',
          conversation_id: '42@lid',
          platform: 'whatsapp',
        },
      ],
    })
    .mockResolvedValue({ rows: [] });
  await expect(
    new EmbeddingService('key', { query } as unknown as Pool, '').processMessage('1')
  ).rejects.toThrow('expected 2');
  expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT'))).toBe(false);
});

const vector = [0.1, 0.2];
const makeChunks = (count: number): MessageChunk[] =>
  Array.from({ length: count }, (_, index) => ({
    messageId: String(index),
    chunkIndex: index,
    content: `text ${index}`,
  }));

function providers() {
  process.env.EMBEDDING_MODEL = 'configured-openai';
  process.env.EMBEDDING_DIMENSIONS = '2';
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const generateEmbedding = jest.fn().mockResolvedValue(vector);
  create.mockImplementation(async ({ input }: { input: string[] }) => ({
    data: input.map(() => ({ embedding: vector })),
  }));
  const db = { query } as unknown as Pool;
  return {
    openai: new EmbeddingService('key', db, ''),
    llama: new LlamaEmbeddingService(
      { generateEmbedding } as unknown as LlamaService,
      db,
      '',
      'configured-llama'
    ),
    query,
    generateEmbedding,
  };
}

test.each(['openai', 'llama'] as const)(
  '%s preserves batch size, order and pauses only between batches',
  async provider => {
    const services = providers();
    const chunks = makeChunks(provider === 'openai' ? 101 : 11);
    const timeout = jest.spyOn(global, 'setTimeout');
    expect(await services[provider].generateEmbeddings(chunks)).toEqual(
      chunks.map(chunk => ({ ...chunk, embedding: vector }))
    );
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout.mock.calls[0][1]).toBe(100);
    if (provider === 'openai') {
      expect(create.mock.calls.map(([request]) => request.input.length)).toEqual([100, 1]);
      expect(create.mock.calls[0][0]).toMatchObject({
        model: 'configured-openai',
        encoding_format: 'float',
      });
    } else {
      expect(services.generateEmbedding.mock.calls.map(([content]) => content)).toEqual(
        chunks.map(chunk => chunk.content)
      );
    }
  }
);

test('OpenAI rejects a provider failure while Llama continues after a failed chunk', async () => {
  const services = providers();
  const failure = new Error('provider unavailable');
  create.mockRejectedValueOnce(failure);
  await expect(services.openai.generateEmbeddings(makeChunks(2))).rejects.toBe(failure);
  services.generateEmbedding.mockRejectedValueOnce(failure);
  const chunks = makeChunks(2);
  expect(await services.llama.generateEmbeddings(chunks)).toEqual([
    { ...chunks[1], embedding: vector },
  ]);
});

test.each(['openai', 'llama'] as const)(
  '%s skips absent vectors and continues inserts using its model and SQL',
  async provider => {
    const services = providers();
    services.query.mockRejectedValueOnce(new Error('insert unavailable'));
    const chunks = makeChunks(3);
    await services[provider].storeEmbeddings([
      chunks[0],
      ...chunks.slice(1).map(chunk => ({ ...chunk, embedding: vector })),
    ]);
    expect(services.query).toHaveBeenCalledTimes(2);
    const expectedModel = provider === 'openai' ? 'configured-openai' : 'configured-llama';
    expect(services.query.mock.calls.map(([, parameters]) => parameters)).toEqual(
      chunks
        .slice(1)
        .map(chunk => [
          chunk.messageId,
          '[0.1,0.2]',
          expectedModel,
          ...(provider === 'llama' ? [chunk.chunkIndex] : []),
        ])
    );
    expect(services.query.mock.calls[0][0].includes('gen_random_uuid()')).toBe(
      provider === 'llama'
    );
  }
);

test('empty batches do not call either provider or schedule a pause', async () => {
  const services = providers();
  const timeout = jest.spyOn(global, 'setTimeout');
  expect(await services.openai.generateEmbeddings([])).toEqual([]);
  expect(await services.llama.generateEmbeddings([])).toEqual([]);
  expect(create).not.toHaveBeenCalled();
  expect(services.generateEmbedding).not.toHaveBeenCalled();
  expect(timeout).not.toHaveBeenCalled();
});

test.each([
  [null, []],
  ['', []],
  ['  short  ', ['  short  ']],
  ['a'.repeat(499), ['a'.repeat(499)]],
  ['a'.repeat(500), ['a'.repeat(500)]],
  ['a'.repeat(2000), ['a'.repeat(2000)]],
  ['a'.repeat(2001), ['a'.repeat(2001)]],
  [`${'a'.repeat(490)}. ${'b'.repeat(20)}.`, [`${'a'.repeat(490)}.`, `${'b'.repeat(20)}.`]],
  [
    `${'a'.repeat(600)}\n\n${'b'.repeat(600)}\n\n${'c'.repeat(900)}`,
    ['a'.repeat(600), 'b'.repeat(600), 'c'.repeat(900)],
  ],
] as Array<[string | null, string[]]>)(
  'both providers retain chunk boundaries for case %#',
  (content, expected) => {
    const services = providers();
    const chunks = expected.map((part, chunkIndex) => ({
      messageId: 'message',
      chunkIndex,
      content: part,
    }));
    for (const provider of [services.openai, services.llama]) {
      expect(provider.chunkMessage('message', content)).toEqual(chunks);
    }
  }
);

test('shared workflow preserves plaintext OpenAI input and decrypts legacy Llama content', async () => {
  const services = providers();
  const key = 'legacy-key';
  const encrypted = encryptString('legacy plaintext', Buffer.from(key, 'utf-8'));
  const legacy = new LlamaEmbeddingService(
    { generateEmbedding: services.generateEmbedding } as unknown as LlamaService,
    { query: services.query } as unknown as Pool,
    key,
    'configured-llama'
  );
  services.query.mockResolvedValueOnce({
    rows: [{ content: 'openai plaintext', conversation_id: 'chat', platform: 'telegram' }],
  });
  await services.openai.processMessage('openai-id');
  expect(create.mock.calls[0][0].input).toEqual(['openai plaintext']);
  services.query.mockResolvedValueOnce({ rows: [{ content: encrypted, conversation_id: 'chat' }] });
  await legacy.processMessage('legacy-id');
  expect(services.generateEmbedding).toHaveBeenCalledWith('legacy plaintext');
});
