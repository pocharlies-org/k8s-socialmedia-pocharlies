import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichArchiveGroupNames } from './archive-group-names';

test('looks up only unnamed archived groups with bounded concurrency and tolerates errors', async () => {
  const chats = [
    { jid: '1@g.us', archived: true, name: '1@g.us' },
    { jid: '2@g.us', archived: true, name: '' },
    { jid: '3@g.us', archived: true, name: 'Known group' },
    { jid: '4@s.whatsapp.net', archived: true, name: '' },
    { jid: '5@g.us', archived: false, name: '' },
    { jid: '6@g.us', archived: true, name: '' },
  ];
  const requested: string[] = [];
  let active = 0;
  let peak = 0;
  await enrichArchiveGroupNames(chats, async jid => {
    requested.push(jid);
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    if (jid === '2@g.us') throw new Error('group unavailable');
    return `Group ${jid[0]}`;
  }, { spacingMs: 0, concurrency: 2 });
  assert.deepEqual(requested, ['1@g.us', '2@g.us', '6@g.us']);
  assert.ok(peak <= 2);
  assert.equal(chats[0].name, 'Group 1');
  assert.equal(chats[1].name, '');
  assert.equal(chats[2].name, 'Known group');
  assert.equal(chats[5].name, 'Group 6');
});

test('stops enrichment if the socket changes', async () => {
  const chats = [
    { jid: '1@g.us', archived: true, name: '' },
    { jid: '2@g.us', archived: true, name: '' },
  ];
  let current = true;
  let requests = 0;
  await enrichArchiveGroupNames(chats, async () => {
    requests++;
    current = false;
    return 'Stale name';
  }, { spacingMs: 0, concurrency: 1, isCurrent: () => current });
  assert.equal(requests, 1);
  assert.deepEqual(chats.map(chat => chat.name), ['', '']);
});
