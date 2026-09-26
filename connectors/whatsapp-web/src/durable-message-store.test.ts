import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import {
  ensureDurableTables,
  getMessageKeysForChat,
  listStoredContacts,
  markMessageDeleted,
  markMessageEdited,
  storeContact,
  storeMessageReaction,
  storeRawWAMessage,
  getRawWAMessage,
  upsertChatState,
} from './durable-message-store';

test('durable table bootstrap holds one transaction advisory lock on a dedicated client', async () => {
  const calls: string[] = [];
  const original = pg.Pool.prototype.connect;
  (pg.Pool.prototype as any).connect = async () => ({
    query: async (sql: string) => { calls.push(sql); return { rows: [] }; },
    release: () => { calls.push('RELEASE'); },
  });
  try {
    await ensureDurableTables();
    assert.equal(calls[0], 'BEGIN');
    assert.match(calls[1], /pg_advisory_xact_lock/);
    assert.equal(calls.at(-2), 'COMMIT');
    assert.equal(calls.at(-1), 'RELEASE');
  } finally {
    (pg.Pool.prototype as any).connect = original;
  }
});

interface QueryCall {
  sql: string;
  params: unknown[];
}

function stubPool(rows: Record<string, unknown>[] = []): { calls: QueryCall[]; restore: () => void } {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    return Promise.resolve({ rows });
  };
  return { calls, restore: () => ((pg.Pool.prototype as any).query = original) };
}

test('raw WAMessage persistence is account-scoped and durable', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool();
  try {
    await storeRawWAMessage({
      key: { remoteJid: '34600@s.whatsapp.net', id: 'abc', fromMe: false },
      message: { conversation: 'hello' },
      messageTimestamp: 1_700_000_000,
      pushName: 'Ada',
    } as any);
    const insert = calls.find(call => /INSERT INTO whatsapp_message_payloads/i.test(call.sql))!;
    assert.equal(insert.params[0], 'professional:abc');
    assert.equal(insert.params[1], 'professional');
    assert.equal(insert.params[2], 'professional:34600@c.us');
    assert.match(String(insert.params[3]), /remoteJid/);
  } finally {
    restore();
  }
});

test('PN echo payload indexes under its verified LID while preserving the provider key', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const original = pg.Pool.prototype.query;
  const calls: QueryCall[] = [];
  (pg.Pool.prototype as any).query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows: /SELECT id FROM conversations/.test(sql) ? [{ id: 'professional:12345@lid' }] : [] };
  };
  try {
    await storeRawWAMessage({
      key: { remoteJid: '34600@s.whatsapp.net', id: 'outbound', fromMe: true },
      message: { conversation: 'hello' },
    } as any);
    assert.equal(calls[1].params[2], 'professional:12345@lid');
    assert.match(String(calls[1].params[3]), /34600@s\.whatsapp\.net/);
  } finally {
    (pg.Pool.prototype as any).query = original;
  }
});

test('message mutations persist edit and delete flags without claiming delivery', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool();
  try {
    await markMessageEdited('abc', 'edited text', 'TEXT');
    await markMessageDeleted('abc');
    assert.match(calls[0].sql, /is_edited = TRUE/i);
    assert.equal(calls[0].params[0], 'professional:abc');
    assert.match(calls[1].sql, /is_deleted = TRUE/i);
    assert.equal(calls[1].params[0], 'professional:abc');
  } finally {
    restore();
  }
});

test('read keys select every unread inbound message for one account and chat', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool([
    {
      wa_message_id: 'professional:m1',
      remote_jid: '34600@s.whatsapp.net',
      from_me: false,
      participant_jid: '34600@s.whatsapp.net',
      message_timestamp_ms: '1700000000000',
    },
  ]);
  try {
    const keys = await getMessageKeysForChat('34600@c.us', { unreadOnly: true });
    assert.equal(keys.length, 1);
    assert.equal(keys[0].key.id, 'm1');
    assert.equal(keys[0].key.remoteJid, '34600@s.whatsapp.net');
    const keyQuery = calls.find(call => /FROM whatsapp_message_keys k/i.test(call.sql))!;
    assert.match(keyQuery.sql, /m\.direction = 'INBOUND'/i);
    assert.match(keyQuery.sql, /m\.status IS DISTINCT FROM 'read'/i);
    assert.equal(keyQuery.params[0], 'professional:34600@c.us');
  } finally {
    restore();
  }
});

test('chat state and contacts retain account isolation', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool([{ jid: '34600@s.whatsapp.net', name: 'Ada' }]);
  try {
    await upsertChatState('34600@c.us', { archived: true, pinned: false, muteUntil: null });
    await storeContact({ jid: '34600@s.whatsapp.net', name: 'Ada', phone: '+34600' });
    const contacts = await listStoredContacts();
    assert.equal(contacts[0].name, 'Ada');
    assert.equal(calls[0].params[0], 'professional');
    assert.equal(calls[1].params[0], 'professional');
    assert.equal(calls[2].params[0], 'professional');
  } finally {
    restore();
  }
});

test('raw message lookup returns undefined when no durable row exists', async () => {
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const { restore } = stubPool([]);
  try {
    assert.equal(await getRawWAMessage('missing'), undefined);
  } finally {
    restore();
  }
});

test('raw message lookup uses the same normalized, account-scoped chat key it stores', async () => {
  const previous = process.env.CONNECTOR_ACCOUNT;
  const { calls, restore } = stubPool([
    {
      message_key: JSON.stringify({ remoteJid: '34600@s.whatsapp.net', id: 'abc', fromMe: false }),
      message_payload: JSON.stringify({ conversation: 'hello' }),
      message_timestamp_ms: '1700000000000',
      push_name: 'Ada',
    },
  ]);
  try {
    process.env.CONNECTOR_ACCOUNT = 'personal';
    const personal = await getRawWAMessage('abc', '34600@c.us');
    assert.equal(personal?.message?.conversation, 'hello');
    assert.equal(calls.at(-1)?.params[0], 'abc');
    assert.equal(calls.at(-1)?.params[2], '34600@c.us');
    process.env.CONNECTOR_ACCOUNT = 'professional';
    await getRawWAMessage('abc', '34600@s.whatsapp.net');
    assert.equal(calls.at(-1)?.params[0], 'professional:abc');
    assert.equal(calls.at(-1)?.params[2], 'professional:34600@c.us');
  } finally {
    if (previous === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previous;
    restore();
  }
});

test('read-key lookup normalizes a native Baileys user jid to the stored chat id', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool([]);
  try {
    await getMessageKeysForChat('34600@s.whatsapp.net');
    const keyQuery = calls.find(call => /FROM whatsapp_message_keys k/i.test(call.sql))!;
    assert.equal(keyQuery.params[0], 'professional:34600@c.us');
  } finally {
    restore();
  }
});

test('reactions use an account-scoped target and explicit removal state', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const { calls, restore } = stubPool();
  try {
    await storeMessageReaction({ targetMessageId: 'target', reactorJid: '34600', reactionMessageId: 'reaction', emoji: ':ok:' });
    await storeMessageReaction({ targetMessageId: 'target', reactorJid: '34600', emoji: '' });
    assert.equal(calls[0].params[0], 'professional');
    assert.equal(calls[0].params[1], 'professional:target');
    assert.equal(calls[0].params[5], false);
    assert.equal(calls[1].params[5], true);
  } finally {
    restore();
  }
});
