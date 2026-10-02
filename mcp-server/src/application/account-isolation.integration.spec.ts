import { Client } from 'pg';
import { join } from 'node:path';
import { runMigrations } from '../infrastructure/database/migrate';
import { InstagramIngestionService } from './instagram-ingestion.service';
import { MessageIngestionService } from './message-ingestion.service';
import { SearchService } from './search.service';
import { DatabaseRepository } from '../infrastructure/database/repository';
import { MCPServer } from '../mcp/server';

const integration = process.env.ACCOUNT_INTEGRATION === 'true' ? describe : describe.skip;
integration('real PostgreSQL account and channel isolation', () => {
  let db: Client;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.pathname !== '/account_isolation_test') throw new Error('Requires dedicated disposable account_isolation_test DB');
    process.env.SOCIAL_ACCOUNTS_FILE = join(__dirname, '../domain/accounts.fixture.json');
    db = new Client({ connectionString: url.toString() });
    await db.connect();
    await runMigrations(db);
    await db.query('BEGIN');
  }, 30000);
  afterAll(async () => { if (db) { await db.query('ROLLBACK'); await db.end(); } });

  test('ingests duplicate provider IDs in two WhatsApp and three Instagram accounts', async () => {
    const wa = new MessageIngestionService(db as any, '');
    for (const account of ['personal', 'secondary']) await wa.handleMessageReceived({
      eventType: 'message.received', account, conversationId: '42@s.whatsapp.net', senderWaId: '42@s.whatsapp.net', waMessageId: 'same-message', waTimestamp: '2026-09-12T00:00:00Z', content: 'isolationneedle', messageType: 'TEXT', isForwarded: false,
    } as any);
    const ig = new InstagramIngestionService(db as any);
    for (const account of ['personal', 'instagram', 'other_ig']) await ig.handleEvent({ platform: 'instagram', account, eventType: 'dm', senderId: '42', conversationId: '42', messageId: 'same-message', text: 'isolationneedle', timestamp: '2026-09-12T00:00:00Z' });
    const counts = await db.query('SELECT count(*)::int AS count, count(DISTINCT sender_wa_id)::int AS senders FROM messages');
    expect(counts.rows[0]).toEqual({ count: 5, senders: 5 });
  });
  test('Instagram raw and indexed search selectors return only requested scope', async () => {
    const search = new SearchService('', db as any, '');
    for (const account of ['personal', 'instagram', 'other_ig']) {
      for (const chatId of ['42', `instagram:${account}:thread_42`]) {
        const results = await search.keywordSearch('isolationneedle', { account, platform: 'instagram', chatId, sender: '42' });
        expect(results).toHaveLength(1);
        expect(results[0].account).toBe(account);
      }
    }
    const all = await search.keywordSearch('isolationneedle', { chatId: 'secondary:42@s.whatsapp.net' });
    expect(all).toHaveLength(1);
    expect(all[0].account).toBe('secondary');
  });
  test('WhatsApp readers exclude Instagram with identical account ID', async () => {
    const repo = new DatabaseRepository(db as any);
    const list = await repo.listConversations({ account: 'personal' });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('42@s.whatsapp.net');
    const users = await repo.searchParticipants('42', 20, 'personal');
    expect(users).toHaveLength(1);
    expect(users[0].conversationId).toBe('42@s.whatsapp.net');
    const server: any = Object.create(MCPServer.prototype);
    server.dbClient = db;
    await expect(server.handleGetChat({ account: 'personal', chatId: 'instagram:personal:thread_42' })).rejects.toThrow();
    await expect(server.handleGetChat({ account: 'instagram', chatId: 'instagram:instagram:thread_42' })).rejects.toThrow('not found');
    const data = JSON.parse((await server.handleWhatsAppGetMessages({ account: 'instagram', chatId: 'instagram:instagram:thread_42' })).content[0].text);
    expect(data.messages).toEqual([]);
  });
});
