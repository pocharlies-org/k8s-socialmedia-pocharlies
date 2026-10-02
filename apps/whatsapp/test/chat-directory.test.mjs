import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatDirectory } from '../lib/chat-directory.mjs';

test('chat cursor preserves microseconds, scopes and excludes internal fields', async () => {
  const query = async () => [
    { id: 'z', _sortTimestamp: '2026-09-27 12:34:56.123456', name: 'Z' },
    { id: 'a', _sortTimestamp: null, name: 'A' },
  ];
  const first = await readChatDirectory({ query, account: 'alpha', limit: 1 });
  assert.deepEqual(first.chats, [{ id: 'z', name: 'Z' }]);
  const cursor = JSON.parse(Buffer.from(first.nextCursor, 'base64url'));
  assert.equal(cursor.time, '2026-09-27 12:34:56.123456');
  let requested;
  const second = await readChatDirectory({ query: async (sql, args) => { requested = {sql, args}; return []; }, account: 'alpha', cursor: first.nextCursor, limit: 1 });
  assert.equal(second.nextCursor, null);
  assert.deepEqual(requested.args, ['alpha', false, 'z', cursor.time, 2]);
  assert.match(requested.sql, /IS NULL OR/);
  for (const scope of [{account:'beta'}, {account:'alpha', archived:true}]) {
    await assert.rejects(readChatDirectory({query, ...scope, cursor:first.nextCursor}), {status:400});
  }
});

test('null-timestamp cursor continues through older empty chats', async () => {
  const first = await readChatDirectory({query: async () => [{id:'z',_sortTimestamp:null},{id:'y',_sortTimestamp:null}], account:'alpha',limit:1});
  await readChatDirectory({query: async (sql,args) => {
    assert.match(sql,/IS NULL AND c.id < \$3/);
    assert.deepEqual(args,['alpha',false,'z',2]);
    return [];
  },account:'alpha',limit:1,cursor:first.nextCursor});
});

test('invalid pagination fails before accessing storage', async () => {
  const query = async () => { throw new Error('must not query'); };
  for (const limit of [0,-1,501,1.2,'bad']) await assert.rejects(readChatDirectory({query,account:'a',limit}), {status:400});
  for (const cursor of ['!', 'a'.repeat(4097), Buffer.from('{}').toString('base64url')]) await assert.rejects(readChatDirectory({query,account:'a',cursor}), {status:400});
});
