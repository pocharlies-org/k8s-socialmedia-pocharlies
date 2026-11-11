import assert from 'node:assert/strict';
import test from 'node:test';
import { generateWAMessageContent, proto, type WAMessage } from '@whiskeysockets/baileys';
import { activePinnedMessages, capturedPin, pinMessageContent } from './pinned-messages';

const chat = '123@g.us';
const now = 1790600000000;
function action(id: string, target: string, pinned = true, timestamp = now, duration = 86400): WAMessage {
  return {key: {id, remoteJid: chat}, message: {
    pinInChatMessage: {key: {id: target, remoteJid: chat}, type: pinned ? 1 : 2, senderTimestampMs: timestamp},
    messageContextInfo: {messageAddOnDurationInSecs: duration},
  }};
}

test('installed generator accepts flat pin contract and correct unpin enum', async () => {
  const key = {id: 'target', remoteJid: chat, fromMe: false, participant: '456@s.whatsapp.net'};
  const pin = await generateWAMessageContent(pinMessageContent(key, chat, true, 2592000), {});
  assert.equal(pin.pinInChatMessage?.type, 1);
  assert.deepEqual(pin.pinInChatMessage?.key, key);
  assert.equal(pin.messageContextInfo?.messageAddOnDurationInSecs, 2592000);
  const unpin = await generateWAMessageContent(pinMessageContent(key, chat, false), {});
  assert.equal(unpin.pinInChatMessage?.type, 2);
  assert.equal(unpin.messageContextInfo?.messageAddOnDurationInSecs, 0);
  assert.equal(key.id, 'target');
});

test('wrapped protobuf actions preserve duration and timestamp', () => {
  const source = action('pin', 'target');
  const encoded = proto.Message.encode(proto.Message.create(source.message!)).finish();
  const wrapped = {...source, message: {ephemeralMessage: {message: proto.Message.decode(encoded)}}};
  assert.deepEqual(capturedPin(wrapped, chat), {messageId:'target', actionId:'pin', pinned:true, timestampMs:now, expiresAtMs:now+86400000});
});

test('legacy group IDs and normalized phone realms remain valid', () => {
  assert.equal(pinMessageContent({id:'x',remoteJid:'123-456@g.us'},'123-456@g.us',true).type,1);
  assert.equal(pinMessageContent({id:'x',remoteJid:'123@s.whatsapp.net'},'123@c.us',true).type,1);
});

test('later expired or unpinned actions never resurrect old pins', () => {
  const rows = [action('old', 'a', true, now - 1000, 2592000), action('new', 'a', true, now, 86400),
    action('b-pin', 'b'), action('b-unpin', 'b', false, now + 1)];
  assert.deepEqual(activePinnedMessages(rows, chat, now + 86400000), []);
  assert.deepEqual(activePinnedMessages([...rows].reverse(), chat, now + 86400000), []);
});

test('equal timestamp unpin wins and only three newest active pins remain', () => {
  assert.deepEqual(activePinnedMessages([action('z','a'), action('a','a',false)],chat,now), []);
  assert.deepEqual(activePinnedMessages([action('a','a',false), action('z','a')],chat,now), []);
  const rows = [1,2,3,4].map(n => action(String(n), String(n), true, now+n));
  assert.deepEqual(activePinnedMessages(rows,chat,now+10).map(row=>row.messageId), ['4','3','2']);
});

test('rejects foreign chats, unknown types, missing duration and invalid timestamps', () => {
  assert.equal(capturedPin(action('a','target'), '999@g.us'), null);
  const foreign = action('a','target'); foreign.message!.pinInChatMessage!.key!.remoteJid='999@g.us';
  assert.equal(capturedPin(foreign,chat),null);
  for (const duration of [0,-1,60,NaN]) assert.equal(capturedPin(action('a','target',true,now,duration),chat),null);
  for (const timestamp of [0,-1,Infinity,NaN]) assert.equal(capturedPin(action('a','target',true,timestamp),chat),null);
  const unknown = action('a','target'); unknown.message!.pinInChatMessage!.type=0;
  assert.equal(capturedPin(unknown,chat),null);
  assert.throws(()=>pinMessageContent({id:'x',remoteJid:'999@g.us'},chat,true));
  assert.throws(()=>pinMessageContent({id:'x',remoteJid:chat},chat,true,60));
});
