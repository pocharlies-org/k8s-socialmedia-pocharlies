import { clearDirty, listDirty, pendingLlm, SNAPSHOT_DELAY_MINUTES, snapshotCursor, type Db } from './state';

const missingTable = Object.assign(new Error('relation "brain_window_dirty" does not exist'), { code: '42P01' });
const failing = (e: Error): Db => ({ query: jest.fn(async () => { throw e; }) });

describe('dirty mailbox is fail-soft until migration 017 of #148 creates the table', () => {
  it('listDirty: 42P01 => empty', async () => {
    await expect(listDirty(failing(missingTable), 'personal')).resolves.toEqual([]);
  });

  it('clearDirty: 42P01 => no-op (it used to throw)', async () => {
    await expect(clearDirty(failing(missingTable), 'personal', { conversationId: 'c', seenUpTo: '2026-09-28 09:00:00+00' })).resolves.toBeUndefined();
  });

  it('any other error is still thrown by both', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: '08006' });
    await expect(listDirty(failing(boom), 'personal')).rejects.toThrow('connection reset');
    await expect(clearDirty(failing(boom), 'personal', { conversationId: 'c', seenUpTo: 'x' })).rejects.toThrow('connection reset');
  });
});

describe('SQL shape that the in-memory store cannot prove', () => {
  it('snapshotCursor lags by 15 minutes', async () => {
    const db: Db = { query: jest.fn(async () => ({ rows: [] })) };
    await snapshotCursor(db, 'personal');
    const sql = String((db.query as jest.Mock).mock.calls[0][0]);
    expect(SNAPSHOT_DELAY_MINUTES).toBe(15);
    expect(sql).toMatch(/m\.created_at <= now\(\) - interval '15 minutes'/);
  });

  it('the sender name comes from metadata->>sender_name (no join to participants, no sender_id)', async () => {
    const db: Db = { query: jest.fn(async () => ({ rows: [] })) };
    const { fetchChatPage } = await import('./state');
    await fetchChatPage(db, 'personal', 'c', { fromTs: null, after: null, limit: 10 });
    const sql = String((db.query as jest.Mock).mock.calls[0][0]);
    expect(sql).toContain("m.metadata->>'sender_name'");
    expect(sql).toContain('m.wa_message_id');
    expect(sql).not.toMatch(/sender_id|JOIN participants/i);
  });

  it('pendingLlm: limit 0 does not query; null has no LIMIT; n has LIMIT', async () => {
    const db: Db = { query: jest.fn(async () => ({ rows: [] })) };
    await pendingLlm(db, 'personal', 0);
    expect(db.query).not.toHaveBeenCalled();
    await pendingLlm(db, 'personal', null);
    await pendingLlm(db, 'personal', 7);
    const [a, b] = (db.query as jest.Mock).mock.calls;
    expect(String(a[0])).not.toMatch(/LIMIT/);
    expect(String(b[0])).toMatch(/LIMIT \$2/);
    expect(b[1]).toEqual(['personal', 7]);
  });
});
