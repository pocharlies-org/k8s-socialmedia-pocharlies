import { Pool } from 'pg';
import { join } from 'node:path';
import { EventType, MessageReceivedEvent } from '@mcp-socialmedia/shared';
import { MessageIngestionService } from './message-ingestion.service';
import { EmbeddingJob } from '../infrastructure/jobs/embedding-job';
import { EmbeddingService } from './embedding.service';
import { isWhatsAppUpdate } from '../domain/whatsapp-surface';

jest.mock('pino', () => ({ __esModule: true, default: () => ({ debug: jest.fn(), info: jest.fn(), error: jest.fn() }) }));
jest.mock('./embedding.service');

function event(account: string, conversationId: string): MessageReceivedEvent {
  return {
    eventType: EventType.MESSAGE_RECEIVED, account, conversationId,
    senderWaId: '123@s.whatsapp.net', waMessageId: 'same-id',
    waTimestamp: '2026-09-27T12:00:00Z', content: 'ordinary text',
    messageType: 'TEXT', isForwarded: false,
  } as MessageReceivedEvent;
}

describe('WhatsApp conversational ingestion boundary', () => {
  beforeAll(() => { process.env.SOCIAL_ACCOUNTS_FILE = join(__dirname, '../domain/accounts.fixture.json'); });
  beforeEach(() => jest.clearAllMocks());

  test.each(['status@broadcast', 'secondary:status@broadcast', '123@newsletter', 'secondary:123@newsletter'])(
    '%s never writes conversations or requests embeddings', async conversationId => {
      const query = jest.fn();
      const db = { query } as unknown as Pool;
      await new MessageIngestionService(db, '').handleMessageReceived(event('secondary', conversationId));
      await new EmbeddingJob('', db, '', '').handleMessageReceived(event('secondary', conversationId));
      expect(query).not.toHaveBeenCalled();
      expect(EmbeddingService.prototype.processMessage).not.toHaveBeenCalled();
    }
  );

  test.each(['123@g.us', '123@s.whatsapp.net', '123@lid', 'secondary:123@s.whatsapp.net'])(
    'ordinary chat %s is not filtered by text or emoji', conversationId => {
      expect(isWhatsAppUpdate(conversationId)).toBe(false);
    }
  );

  test('embedding lookup scopes identical provider IDs by account, chat and platform', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'secondary-message' }] });
    const job = new EmbeddingJob('', { query } as unknown as Pool, '', '');
    await job.handleMessageReceived(event('secondary', '123@s.whatsapp.net'));
    expect(query.mock.calls[0][0]).toContain("platform = 'whatsapp'");
    expect(query.mock.calls[0][0]).toContain('account = $1');
    expect(query.mock.calls[0][0]).toContain('conversation_id = $2');
    expect(query.mock.calls[0][1]).toEqual(['secondary', 'secondary:123@s.whatsapp.net', 'secondary:same-id']);
    expect(EmbeddingService.prototype.processMessage).toHaveBeenCalledWith('secondary-message');
  });

  test('missing message and invalid account never trigger embedding', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const job = new EmbeddingJob('', { query } as unknown as Pool, '', '');
    await job.handleMessageReceived(event('personal', '123@s.whatsapp.net'));
    await expect(job.handleMessageReceived(event('unknown-account', '123@s.whatsapp.net'))).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
    expect(EmbeddingService.prototype.processMessage).not.toHaveBeenCalled();
  });
});
