/**
 * SKIRM-107: la ruta de escritura de WhatsApp pasa por `accountKey`, que ahora
 * rechaza un id ya namespaced a OTRA cuenta (`Cross-account identifier`). Cada
 * cuenta del registro ingiere como antes; el id ajeno se rechaza ANTES de
 * escribir nada y queda en el log (el handler lo registra y lo relanza).
 */
const mockError = jest.fn();
jest.mock('pino', () => ({
  __esModule: true,
  default: () => ({ info: jest.fn(), warn: jest.fn(), error: mockError, debug: jest.fn() }),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventType, type MessageReceivedEvent } from '@mcp-socialmedia/shared';
import { resetAccountRegistryCache } from '../domain/account-registry';
import { MessageIngestionService } from './message-ingestion.service';

const wa = (accountId: string, extra: object = {}) => ({
  channel: 'whatsapp',
  accountId,
  connectorUrl: `http://wa-${accountId}:3001`,
  ...extra,
});

let dir: string;
const previous = process.env.SOCIAL_ACCOUNTS_FILE;

/** personal + professional + leila, and `old`, a disabled account with history. */
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-ingestion-'));
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    file,
    JSON.stringify([wa('personal'), wa('professional'), wa('leila'), wa('old', { enabled: false })])
  );
  process.env.SOCIAL_ACCOUNTS_FILE = file;
  resetAccountRegistryCache();
});
afterAll(() => {
  if (previous === undefined) delete process.env.SOCIAL_ACCOUNTS_FILE;
  else process.env.SOCIAL_ACCOUNTS_FILE = previous;
  resetAccountRegistryCache();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => mockError.mockClear());

function event(account: string | undefined, over: Partial<MessageReceivedEvent> = {}) {
  return {
    eventType: EventType.MESSAGE_RECEIVED,
    account,
    conversationId: '34600@s.whatsapp.net',
    senderWaId: '34600@s.whatsapp.net',
    waMessageId: 'same-message',
    waTimestamp: '2026-10-08T10:00:00Z',
    content: 'hola',
    messageType: 'TEXT',
    isForwarded: false,
    ...over,
  } as MessageReceivedEvent;
}

function ingestion() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
  };
  return { calls, service: new MessageIngestionService(pool as any, '') };
}
const messageInsert = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find(c => c.sql.includes('INSERT INTO messages'))!.params;

describe('WhatsApp ingestion keeps working for every enabled account', () => {
  it.each([
    ['personal', '34600@s.whatsapp.net', 'same-message'],
    ['professional', 'professional:34600@s.whatsapp.net', 'professional:same-message'],
    ['leila', 'leila:34600@s.whatsapp.net', 'leila:same-message'],
  ])('%s files the message under its own namespace', async (account, conversationId, wamId) => {
    const { calls, service } = ingestion();
    await service.handleMessageReceived(event(account));
    const params = messageInsert(calls);
    expect(params[0]).toBe(conversationId);
    expect(params[1]).toBe(wamId);
    expect(params[2]).toBe(conversationId);
    expect(params[13]).toBe(account);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('an omitted account is personal (the historical default)', async () => {
    const { calls, service } = ingestion();
    await service.handleMessageReceived(event(undefined));
    expect(messageInsert(calls)[0]).toBe('34600@s.whatsapp.net');
  });

  it('the same provider id under two accounts never collides', async () => {
    const a = ingestion();
    const b = ingestion();
    await a.service.handleMessageReceived(event('personal'));
    await b.service.handleMessageReceived(event('professional'));
    expect(messageInsert(a.calls)[1]).not.toBe(messageInsert(b.calls)[1]);
  });

  it('an id the connector already namespaced to its OWN account is not prefixed twice', async () => {
    const { calls, service } = ingestion();
    await service.handleMessageReceived(
      event('professional', {
        conversationId: 'professional:34600@s.whatsapp.net',
        senderWaId: 'professional:34600@s.whatsapp.net',
        waMessageId: 'professional:same-message',
      })
    );
    const params = messageInsert(calls);
    expect(params[0]).toBe('professional:34600@s.whatsapp.net');
    expect(params[1]).toBe('professional:same-message');
  });
});

describe('a disabled account behaves as before the guard', () => {
  it('is refused by normalizeAccount, before any id is built or written', async () => {
    const { calls, service } = ingestion();
    await expect(service.handleMessageReceived(event('old'))).rejects.toThrow(
      'Unknown or disabled account: old'
    );
    expect(calls).toHaveLength(0);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Unknown or disabled account'));
  });
});

describe('an id namespaced to another account', () => {
  it.each([
    ['conversationId', { conversationId: 'leila:34600@s.whatsapp.net' }],
    ['senderWaId', { senderWaId: 'leila:34600@s.whatsapp.net' }],
    ['waMessageId', { waMessageId: 'leila:same-message' }],
  ])('%s is rejected with a logged error and nothing is written', async (_field, over) => {
    const { calls, service } = ingestion();
    await expect(service.handleMessageReceived(event('professional', over))).rejects.toThrow(
      'Cross-account identifier'
    );
    expect(calls).toHaveLength(0);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Cross-account identifier'));
  });

  it('is rejected under personal too (used to be filed as the leila conversation)', async () => {
    const { calls, service } = ingestion();
    await expect(
      service.handleMessageReceived(
        event('personal', { conversationId: 'leila:34600@s.whatsapp.net' })
      )
    ).rejects.toThrow('Cross-account identifier');
    expect(calls).toHaveLength(0);
  });
});
