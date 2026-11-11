const redisStore = { get: jest.fn(), setex: jest.fn() };
jest.mock('ioredis', () => jest.fn().mockImplementation(() => redisStore));
jest.mock('pino', () => () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

import { SummarizationService } from './summarization.service';

function service(content: string | null) {
  const db = {
    query: jest.fn().mockResolvedValue({
      rows: [
        { content: 'hola', sender_wa_id: 'a', wa_timestamp: new Date('2026-10-01T10:00:00Z') },
      ],
    }),
  };
  const svc = new SummarizationService(
    'sk-socialmedia',
    db as any,
    'redis://x',
    'k',
    'http://litellm/v1',
    'tooling'
  );
  const create = jest.fn().mockResolvedValue({ choices: [{ message: { content } }] });
  (svc as any).openai = { chat: { completions: { create } } };
  return { svc, create };
}

describe('SummarizationService (LiteLLM tooling)', () => {
  beforeEach(() => {
    redisStore.get.mockReset().mockResolvedValue(null);
    redisStore.setex.mockReset();
  });

  it('asks the resident model without thinking so the small budget reaches the content', async () => {
    const { svc, create } = service('Resumen.');
    await expect(svc.summarizeChat('chat-1', { style: 'brief', language: 'es' })).resolves.toBe(
      'Resumen.'
    );
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'tooling',
      max_tokens: 200,
      reasoning_effort: 'none',
    });
    expect(redisStore.setex).toHaveBeenCalledWith(
      expect.stringContaining('summary:chat-1'),
      3600,
      'Resumen.'
    );
  });

  it('does not cache an empty answer', async () => {
    const { svc } = service('');
    await expect(svc.summarizeChat('chat-1')).resolves.toBe('Failed to generate summary');
    expect(redisStore.setex).not.toHaveBeenCalled();
  });
});
