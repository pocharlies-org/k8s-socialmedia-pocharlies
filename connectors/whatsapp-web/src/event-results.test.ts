import assert from 'node:assert/strict';
import test from 'node:test';
import { readEventResults } from './event-results';
import { buildEventResponse } from './event-responses';

const ownJid = '10000@s.whatsapp.net';
const creatorJid = '20000@s.whatsapp.net';
const key = {id: 'event-1', remoteJid: '123@g.us', participant: creatorJid};
const secret = Buffer.alloc(32, 8);
const creation = {key, message: {eventMessage: {name: 'Fixture'}, messageContextInfo: {messageSecret: secret}}};
const resolvePhoneJid = async () => null;
const reply = (id: string, timestampMs: number, attendance: 'going' | 'maybe') => ({
  waMessageId: id, key: {id, remoteJid: key.remoteJid, fromMe: true}, timestampMs,
  content: buildEventResponse({eventKey: key, eventSecret: secret, creatorJid, responderJid: ownJid, attendance, timestampMs}),
});

test('results traverse all pages and latest attendance wins across page boundaries', async () => {
  const requested: (string | null)[] = [];
  const [result] = await readEventResults(key.remoteJid, [key.id, key.id], {
    ownJid, resolvePhoneJid, loadMessage: async () => creation,
    loadReplies: async (_id, _chat, {cursor}) => {
      requested.push(cursor);
      return cursor === null ? {items: [reply('a', 2000, 'maybe')], nextCursor: 'a'} : {items: [reply('b', 1000, 'going')], nextCursor: null};
    },
  });
  assert.deepEqual(requested, [null, 'a']);
  assert.equal(result.available, true);
  assert.equal(result.availability, 'local_partial');
  assert.equal(result.selectedByMe, 'maybe');
  assert.deepEqual(result.counts, {going: 0, not_going: 0, maybe: 1});
  assert.equal(result.capturedResponders, 1);
});

test('missing creation, key or identity are explicitly unavailable without querying replies', async () => {
  for (const [message, expected] of [[undefined, 'EVENT_NOT_FOUND'], [{...creation, message: {eventMessage: {name: 'Fixture'}}}, 'ENCRYPTION_KEY_UNAVAILABLE'], [{...creation, key: {...key, participant: '777@lid'}}, 'IDENTITY_UNAVAILABLE']] as const) {
    const [result] = await readEventResults(key.remoteJid, [key.id], {
      ownJid, resolvePhoneJid, loadMessage: async () => message,
      loadReplies: async () => {throw new Error('must not query replies');},
    });
    assert.equal(result.available, false);
    assert.equal(result.reason, expected);
  }
});

test('a failed or repeating page rejects instead of presenting incomplete counts as a finished read', async () => {
  const ports = {ownJid, resolvePhoneJid, loadMessage: async () => creation};
  await assert.rejects(readEventResults(key.remoteJid, [key.id], {...ports, loadReplies: async () => {throw new Error('database unavailable');}}), /database unavailable/);
  await assert.rejects(readEventResults(key.remoteJid, [key.id], {...ports, loadReplies: async () => ({items: [], nextCursor: 'same'})}), /did not advance/);
});
