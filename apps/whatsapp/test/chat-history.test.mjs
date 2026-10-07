import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {mergeMessages, mergeRecentMessages, pinnedFirst, shouldSubmitMessageKey, visibleOutgoingMessages} from '../public/chat-history.mjs';

const message = (id, minute, extra = {}) => ({id, timestamp: `2026-09-27T12:${String(minute).padStart(2, '0')}:00Z`, text: id, ...extra});

test('app entrypoint parses as the classic script loaded by index', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /<script\s+src="\/app\.js"\s+defer><\/script>/);
  assert.doesNotThrow(() => new vm.Script(app, {filename:'app.js'}));
});

test('pinned chats precede unpinned chats without changing their relative order', () => {
  const chats = [{id:'a'}, {id:'b', pinned:true}, {id:'c', pinned:false}, {id:'d', pinned:true}];
  assert.deepEqual(pinnedFirst(chats).map(chat => chat.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(chats.map(chat => chat.id), ['a', 'b', 'c', 'd']);
});

test('older page and latest polling page retain full ordered history and replace duplicate ids', () => {
  const current = [message('m3', 3), message('m4', 4)];
  const older = mergeMessages(current, [message('m1', 1), message('m2', 2), message('m3', 3)]);
  const refreshed = mergeMessages(older, [message('m3', 3, {text:'edited'}), message('m4', 4), message('m5', 5)]);
  assert.deepEqual(refreshed.map(item => item.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(refreshed[2].text, 'edited');
  assert.equal(older.length, 4);
});

test('recent polling removes deleted messages in its window but retains older pages', () => {
  const existing = [message('old', 0), message('kept', 3), message('deleted', 4)];
  const result = mergeRecentMessages(existing, [message('kept', 3), message('new', 5)]);
  assert.deepEqual(result.map(item => item.id), ['old', 'kept', 'new']);
});

test('an early provider echo replaces exactly one optimistic bubble', () => {
  const timestamp = '2026-09-27T12:05:00Z';
  const outgoing = [
    {id:'local-1', account:'alpha', text:'igual', timestamp, state:'sending', knownIds:new Set()},
    {id:'local-2', account:'alpha', text:'igual', timestamp, state:'sending', knownIds:new Set()},
  ];
  const echo = {id:'db-1', waMessageId:'wa-1', text:'igual', fromMe:true, timestamp};
  assert.deepEqual(visibleOutgoingMessages([echo], outgoing).map(item => item.id), ['local-2']);
  assert.deepEqual(visibleOutgoingMessages([echo, {...echo, id:'db-2', waMessageId:'wa-2'}], outgoing), []);
  assert.equal(visibleOutgoingMessages([echo], [{...outgoing[0], knownIds:new Set(['wa-1'])}]).length, 1);
  assert.equal(visibleOutgoingMessages([{...echo, fromMe:false}], [outgoing[0]]).length, 1);
  assert.equal(visibleOutgoingMessages([echo], [{...outgoing[0], state:'failed'}]).length, 1);
  assert.equal(visibleOutgoingMessages([echo], [{...outgoing[0], messageId:'wa-1', state:'confirmed'}]).length, 0);
});

test('composer Enter preference honors Shift, composition, keyboard shortcuts and touch screens', () => {
  const key = overrides => ({key:'Enter', shiftKey:false, ctrlKey:false, metaKey:false, isComposing:false, ...overrides});
  assert.equal(shouldSubmitMessageKey(key(), true, false), true);
  assert.equal(shouldSubmitMessageKey(key(), false, false), false);
  assert.equal(shouldSubmitMessageKey(key({ctrlKey:true}), false, false), true);
  assert.equal(shouldSubmitMessageKey(key({metaKey:true}), false, true), true);
  assert.equal(shouldSubmitMessageKey(key({shiftKey:true}), true, false), false);
  assert.equal(shouldSubmitMessageKey(key({isComposing:true}), true, false), false);
  assert.equal(shouldSubmitMessageKey(key(), true, true), false);
});
