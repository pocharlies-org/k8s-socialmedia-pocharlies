import test from 'node:test';
import assert from 'node:assert/strict';
import { loadChatPages } from '../public/chat-directory.mjs';

test('loads more than 500 chats, deduplicates pages and replaces stale rows only at completion', async () => {
  const rows = Array.from({length:650}, (_,i) => ({id:`chat-${i}`}));
  let latest;
  let calls = 0;
  await loadChatPages({previous:[{id:'stale'}],isCurrent:()=>true,
    fetchPage: async cursor => {
      const offset = Number(cursor || 0); calls++;
      return {chats:rows.slice(offset, offset+100),nextCursor:offset+100 < rows.length ? String(offset+100) : null};
    },
    onPage: (chats, more) => { assert.equal(chats.some(chat=>chat.id==='stale'), more); latest=chats; },
  });
  assert.equal(calls,7); assert.deepEqual(latest,rows);
});

test('account change during fetch does not publish old-account rows', async () => {
  let current=true;
  await loadChatPages({isCurrent:()=>current, fetchPage:async()=>{current=false;return {chats:[{id:'private'}]};},onPage:()=>assert.fail('stale response published')});
});

test('failed page retains already published rows and can restart', async () => {
  let latest;
  await assert.rejects(loadChatPages({isCurrent:()=>true,previous:[{id:'older'}],
    fetchPage:async cursor=>{if(cursor)throw new Error('offline');return {chats:[{id:'new'}],nextCursor:'next'};},
    onPage:chats=>{latest=chats;},
  }),/offline/);
  assert.deepEqual(latest,[{id:'new'},{id:'older'}]);
});

test('overlapping page rows stay unique and repeated cursors fail explicitly', async () => {
  let latest;
  await loadChatPages({isCurrent:()=>true,fetchPage:async cursor=>({chats:[{id:'same',name:cursor?'updated':'old'}],nextCursor:cursor?null:'next'}),onPage:chats=>{latest=chats;}});
  assert.deepEqual(latest,[{id:'same',name:'updated'}]);
  await assert.rejects(loadChatPages({isCurrent:()=>true,fetchPage:async()=>({chats:[],nextCursor:'repeat'}),onPage:()=>{}}),/continuar/);
});
