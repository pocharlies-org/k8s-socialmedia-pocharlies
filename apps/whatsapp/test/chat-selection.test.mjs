import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChatBatch } from '../public/chat-selection.mjs';

test('batch deduplicates IDs, tracks partial failures and retains captured account', async () => {
  const calls=[];
  const results=await applyChatBatch({account:'alpha',ids:['one','one','two','three'],action:'archive',isCurrent:()=>true,
    request:async (path,body)=>{calls.push(body);if(body.chat==='two') throw new Error('offline');return {...body,confirmed:true};},
  });
  assert.deepEqual(calls.map(body=>body.chat),['one','two','three']);
  assert(calls.every(body=>body.account==='alpha'));
  assert.deepEqual(results.map(item=>item.ok),[true,false,true]);
  assert.equal(results[1].error,'offline');
});

test('scope changes stop future actions and suppress stale feedback', async () => {
  let active=true;let calls=0;
  const results=await applyChatBatch({account:'alpha',ids:['one','two'],action:'read',isCurrent:()=>active,
    request:async (_,body)=>{calls++;active=false;return {...body,confirmed:true};},onResult:()=>assert.fail('stale feedback'),
  });
  assert.equal(calls,1);assert.equal(results.length,1);
});

test('unconfirmed and cross-account responses are failures', async () => {
  for(const response of [{account:'alpha',chat:'one'},{account:'beta',chat:'one',confirmed:true},{account:'alpha',chat:'other',confirmed:true}]) {
    const results=await applyChatBatch({account:'alpha',ids:['one'],action:'mute',request:async()=>response,isCurrent:()=>true});
    assert.equal(results[0].ok,false);
  }
});

test('invalid actions fail before calling provider', async () => {
  await assert.rejects(applyChatBatch({account:'alpha',ids:['one'],action:'delete',request:()=>assert.fail('must not write'),isCurrent:()=>true}),/válida/);
});
