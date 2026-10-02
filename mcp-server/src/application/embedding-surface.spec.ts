import { Pool } from 'pg';
import { EmbeddingService } from './embedding.service';

jest.mock('pino', () => ({ __esModule: true, default: () => ({ debug: jest.fn(), info: jest.fn(), error: jest.fn(), warn: jest.fn() }) }));

test.each(['123@newsletter', 'status@broadcast', 'secondary:status@broadcast'])(
  'direct embedding requests for historical %s never invoke the model', async conversationId => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: '1', content: 'stored update', conversation_id: conversationId, platform: 'whatsapp' }] });
    const service = new EmbeddingService('synthetic', { query } as unknown as Pool, '');
    const generate = jest.spyOn(service, 'generateEmbeddings').mockResolvedValue([]);
    await service.processMessage('1');
    expect(generate).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  }
);

test('an ordinary chat containing a channel address as text remains eligible', async () => {
  const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: '1', content: '123@newsletter', conversation_id: '123@s.whatsapp.net', platform: 'whatsapp' }] }).mockResolvedValue({ rows: [] });
  const service = new EmbeddingService('synthetic', { query } as unknown as Pool, '');
  const generate = jest.spyOn(service, 'generateEmbeddings').mockResolvedValue([]);
  jest.spyOn(service, 'storeEmbeddings').mockResolvedValue(undefined);
  await service.processMessage('1');
  expect(generate).toHaveBeenCalledTimes(1);
});
