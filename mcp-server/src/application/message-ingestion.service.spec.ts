/**
 * SKIRM-107 C3: the cross-account guard in accountKey on the WRITE path.
 * A message of every registry account is ingested as before; an id namespaced
 * to ANOTHER account is refused before anything is written, and the refusal is
 * logged (it is information: a latent mis-assignment the guard just exposed).
 */
const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('pino', () => ({ __esModule: true, default: () => mockLogger }));

import { join } from 'node:path';
import { EventType, MessageReceivedEvent } from '@mcp-socialmedia/shared';
import { resetAccountRegistryCache } from '../domain/account-registry';
import { MessageIngestionService } from './message-ingestion.service';

function capture() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    }),
  };
  return { calls, service: new MessageIngestionService(pool as any, '') };
}

const insertInto = (calls: Array<{ sql: string; params: unknown[] }>, table: string) =>
  calls.find(c => c.sql.includes(`INSERT INTO ${table} `))!.params;

function event(account: string, over: Partial<MessageReceivedEvent> = {}): MessageReceivedEvent {
  return {
    eventType: EventType.MESSAGE_RECEIVED,
    account,
    conversationId: '42@s.whatsapp.net',
    senderWaId: '42@s.whatsapp.net',
    waMessageId: '3EB0SAME',
    waTimestamp: '2026-10-08T10:00:00Z',
    content: 'hola',
    messageType: 'TEXT',
    isForwarded: false,
    ...over,
  } as MessageReceivedEvent;
}

function useRegistry(file?: string): void {
  if (file) process.env.SOCIAL_ACCOUNTS_FILE = file;
  else delete process.env.SOCIAL_ACCOUNTS_FILE;
  resetAccountRegistryCache();
}

beforeEach(() => jest.clearAllMocks());
afterAll(() => useRegistry());

describe('MessageIngestionService: namespacing per account (default registry)', () => {
  beforeAll(() => useRegistry());

  it.each([
    ['personal', '42@s.whatsapp.net', '3EB0SAME'],
    ['professional', 'professional:42@s.whatsapp.net', 'professional:3EB0SAME'],
    ['leila', 'leila:42@s.whatsapp.net', 'leila:3EB0SAME'],
  ])('%s: files the message under %s as before', async (account, convId, wamId) => {
    const { calls, service } = capture();
    await service.handleMessageReceived(event(account));
    const message = insertInto(calls, 'messages'); // conversation_id, wa_message_id, sender_wa_id
    expect(insertInto(calls, 'conversations')[0]).toBe(convId);
    expect(message[0]).toBe(convId);
    expect(message[1]).toBe(wamId);
    expect(message[2]).toBe(convId);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('an id that already carries the account of the event is idempotent', async () => {
    const { calls, service } = capture();
    await service.handleMessageReceived(
      event('professional', { conversationId: 'professional:42@s.whatsapp.net' })
    );
    expect(insertInto(calls, 'conversations')[0]).toBe('professional:42@s.whatsapp.net');
  });

  it.each([
    ['conversationId', { conversationId: 'leila:42@s.whatsapp.net' }],
    ['senderWaId', { senderWaId: 'leila:42@s.whatsapp.net' }],
    ['waMessageId', { waMessageId: 'leila:3EB0SAME' }],
  ])(
    'an event of professional carrying a leila %s is refused, logged and writes nothing',
    async (_field, over) => {
      const { calls, service } = capture();
      await expect(
        service.handleMessageReceived(event('professional', over as Partial<MessageReceivedEvent>))
      ).rejects.toThrow('Cross-account identifier');
      expect(calls).toHaveLength(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Cross-account identifier')
      );
    }
  );

  it('the personal account refuses an id namespaced to another account too', async () => {
    const { calls, service } = capture();
    await expect(
      service.handleMessageReceived(
        event('personal', { conversationId: 'leila:42@s.whatsapp.net' })
      )
    ).rejects.toThrow('Cross-account identifier');
    expect(calls).toHaveLength(0);
  });
});

describe('MessageIngestionService: a DISABLED account (fixture registry)', () => {
  beforeAll(() => useRegistry(join(__dirname, '../domain/accounts.fixture.json')));
  afterAll(() => useRegistry());

  it('is still refused by normalizeAccount, as before the guard, and writes nothing', async () => {
    const { calls, service } = capture();
    await expect(service.handleMessageReceived(event('disabled'))).rejects.toThrow(
      /Unknown or disabled account: disabled/
    );
    expect(calls).toHaveLength(0);
  });

  it('a historical id of the disabled namespace is recognised, so it cannot be refiled elsewhere', async () => {
    const { calls, service } = capture();
    await expect(
      service.handleMessageReceived(
        event('secondary', { conversationId: 'disabled:42@s.whatsapp.net' })
      )
    ).rejects.toThrow('Cross-account identifier');
    expect(calls).toHaveLength(0);
  });

  it('an enabled non-default account keeps working', async () => {
    const { calls, service } = capture();
    await service.handleMessageReceived(event('arbitrary_3'));
    expect(insertInto(calls, 'conversations')[0]).toBe('arbitrary_3:42@s.whatsapp.net');
  });
});
