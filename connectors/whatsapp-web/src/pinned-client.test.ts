import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { BaileysClient } from './baileys-client';
import { serializeDurableValue } from './whatsapp-capabilities';

test('pin relay uses stored target, correct duration and stable ID after claim, tolerating storage failure', async () => {
  const original=pg.Pool.prototype.query;
  const key={id:'target',remoteJid:'123@g.us',participant:'20000@s.whatsapp.net'};
  const order:string[]=[];
  (pg.Pool.prototype as any).query=async(sql:string)=>{
    if(sql.includes('INSERT INTO whatsapp_message_payloads')){order.push('persist');throw new Error('offline storage');}
    return {rows:[{message_key:serializeDurableValue(key),message_payload:serializeDurableValue({conversation:'Fixture'})}]};
  };
  const client=new BaileysClient('/tmp/unused-pin-test','fixture') as any;
  let relayed:any;
  Object.assign(client,{ready:true,meJid:'10000@s.whatsapp.net',logger:{warn:()=>{}},sock:{
    waUploadToServer:async()=>{throw new Error('Pins must not upload files');},
    relayMessage:async(jid:string,content:any,options:any)=>{
      order.push('relay');relayed=content;assert.equal(jid,'123@g.us');assert.equal(options.messageId,'stable-pin');
    },
  }});
  const input={token:'fixture',conversationId:'123@g.us',targetMessageId:'target',pinned:true,duration:604800};
  try {
    assert.equal(await client.sendPin(input,'stable-pin',async()=>{order.push('claim');}),'stable-pin');
    assert.deepEqual(order,['claim','relay','persist']);
    assert.equal(relayed.pinInChatMessage.type,1);
    assert.deepEqual(relayed.pinInChatMessage.key,key);
    assert.equal(relayed.messageContextInfo.messageAddOnDurationInSecs,604800);
    order.length=0;
    await assert.rejects(client.sendPin({...input,conversationId:'999@g.us'},'stable-pin',async()=>{order.push('claim');}),/Invalid pinned message request/);
    assert.deepEqual(order,[]);
  } finally {pg.Pool.prototype.query=original;}
});

test('outgoing pin persistence uses the verified LID conversation for a phone alias',async()=>{
  const original=pg.Pool.prototype.query;const previous=process.env.CONNECTOR_ACCOUNT;
  process.env.CONNECTOR_ACCOUNT='professional';let storedConversation:unknown;
  (pg.Pool.prototype as any).query=async(sql:string,params:unknown[])=>{
    if(sql.includes('SELECT id FROM conversations'))return {rows:[{id:'professional:777@lid'}]};
    if(sql.includes('INSERT INTO whatsapp_message_payloads')){storedConversation=params[2];return {rows:[]};}
    return {rows:[{message_key:serializeDurableValue({id:'target',remoteJid:'777@lid'}),message_payload:serializeDurableValue({conversation:'Fixture'})}]};
  };
  const client=new BaileysClient('/tmp/unused-pin-test','fixture') as any;
  Object.assign(client,{ready:true,meJid:'10000@s.whatsapp.net',sock:{relayMessage:async()=>{},waUploadToServer:async()=>{throw new Error('no uploads');}}});
  try {
    await client.sendPin({token:'fixture',conversationId:'555@c.us',targetMessageId:'target',pinned:true,duration:86400},'stable-pin',async()=>{});
    assert.equal(storedConversation,'professional:777@lid');
  } finally {
    pg.Pool.prototype.query=original;
    if(previous===undefined)delete process.env.CONNECTOR_ACCOUNT;else process.env.CONNECTOR_ACCOUNT=previous;
  }
});

test('incoming pin envelopes do not become standalone messages or previews',async()=>{
  const original=pg.Pool.prototype.query;const queries:string[]=[];
  (pg.Pool.prototype as any).query=async(sql:string)=>{queries.push(sql);return {rows:[]};};
  const client=new BaileysClient('/tmp/unused-pin-test','fixture') as any;
  let emitted=false;client.on('message',()=>{emitted=true;});
  try {
    const result=await client.ingestMessage({key:{id:'pin',remoteJid:'123@g.us'},message:{
      pinInChatMessage:{key:{id:'target',remoteJid:'123@g.us'},type:1,senderTimestampMs:Date.now()},
      messageContextInfo:{messageAddOnDurationInSecs:86400},
    }});
    assert.equal(result.inserted,false);assert.equal(emitted,false);
    assert.equal(queries.filter(sql=>/INSERT INTO whatsapp_message_payloads/i.test(sql)).length,1);
    assert.equal(queries.filter(sql=>/INSERT INTO messages|UPDATE conversations/i.test(sql)).length,0);
  } finally {pg.Pool.prototype.query=original;}
});
