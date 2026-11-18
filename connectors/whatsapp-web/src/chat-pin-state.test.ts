import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { chatPinState } from './chat-pin-state';
import { applyPinnedChatSnapshot } from './durable-message-store';

test('normalizes Baileys pinned timestamps and explicit unpin deltas', () => {
  assert.equal(chatPinState({ pinned: 1727510400 }), true);
  assert.equal(chatPinState({ pinned: 0 }), false);
  assert.equal(chatPinState({ pinned: null }), false);
  assert.equal(chatPinState({ pinned: true }), true);
  assert.equal(chatPinState({ pinned: false }), false);
  assert.equal(chatPinState({ id: 'chat' }), undefined);
  assert.equal(chatPinState({ pinned: -1 }), undefined);
  assert.equal(chatPinState({ pinned: '1727510400' }), undefined);
});

test('pin snapshot writes only the connector account and protects newer state', async () => {
  const previous = process.env.CONNECTOR_ACCOUNT;
  const original = pg.Pool.prototype.connect;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  process.env.CONNECTOR_ACCOUNT = 'professional';
  (pg.Pool.prototype as any).connect = async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  });
  try {
    const startedAt = new Date('2026-09-28T08:00:00Z');
    assert.equal(await applyPinnedChatSnapshot(new Map([
      ['123@g.us', true], ['456@g.us', false],
    ]), startedAt), 2);
    assert.equal(calls[0].sql, 'BEGIN');
    assert.equal(calls.at(-1)?.sql, 'COMMIT');
    const writes = calls.filter(call => call.sql.includes('INSERT INTO whatsapp_chat_state'));
    assert.deepEqual(writes.map(call => call.params), [
      ['professional', 'professional:123@g.us', true, startedAt],
      ['professional', 'professional:456@g.us', false, startedAt],
    ]);
    assert(writes.every(call => call.sql.includes('updated_at <= $4')));
  } finally {
    (pg.Pool.prototype as any).connect = original;
    if (previous == null) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previous;
  }
});
