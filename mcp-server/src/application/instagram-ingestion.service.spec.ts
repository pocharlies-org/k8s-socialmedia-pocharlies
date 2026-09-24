import { InstagramIngestionService, type InstagramEvent } from './instagram-ingestion.service';

jest.mock('pino', () => () => ({ info: jest.fn(), debug: jest.fn(), error: jest.fn() }));

function capture() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    }),
  };
  return { calls, service: new InstagramIngestionService(pool as any) };
}

const dm = (account: string): InstagramEvent => ({
  platform: 'instagram',
  account,
  eventType: 'dm',
  senderId: '17841400000000001',
  senderUsername: 'buyer',
  conversationId: 't1',
  messageId: 'm1',
  text: 'hola',
  timestamp: '2026-09-24T10:00:00.000Z',
});

const insertInto = (calls: Array<{ sql: string; params: unknown[] }>, table: string) =>
  calls.find(c => c.sql.includes(`INSERT INTO ${table} `))!.params;

describe('InstagramIngestionService account isolation', () => {
  it('files each account under its registry namespace', async () => {
    const shop = capture();
    await shop.service.handleEvent(dm('skirmshop'));
    expect(insertInto(shop.calls, 'messages')[7]).toBe('professional');

    const other = capture();
    await other.service.handleEvent(dm('barbelpapis'));
    expect(insertInto(other.calls, 'messages')[7]).toBe('personal');
  });

  it('keeps the same sender as two participants across two accounts', async () => {
    const a = capture();
    const b = capture();
    await a.service.handleEvent(dm('skirmshop'));
    await b.service.handleEvent(dm('barbelpapis'));
    const pa = insertInto(a.calls, 'participants')[0];
    const pb = insertInto(b.calls, 'participants')[0];
    expect(pa).toBe('ig_skirmshop_17841400000000001');
    expect(pb).toBe('ig_barbelpapis_17841400000000001');
    expect(insertInto(a.calls, 'messages')[2]).toBe(pa); // sender_wa_id matches
  });

  it('keeps conversation and message ids unchanged (no split of existing threads)', async () => {
    const { calls, service } = capture();
    await service.handleEvent(dm('skirmshop'));
    expect(insertInto(calls, 'conversations')[0]).toBe('ig_skirmshop_thread_t1');
    expect(insertInto(calls, 'messages')[0]).toBe('ig_skirmshop_m1');
  });

  it('refuses an undeclared account instead of filing it under personal', async () => {
    const { calls, service } = capture();
    await service.handleEvent(dm('ghost'));
    expect(calls).toHaveLength(0);
  });
});
