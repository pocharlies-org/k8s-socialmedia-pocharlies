import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptEventResponse, proto } from '@whiskeysockets/baileys';
import { captureEventResponse, aggregateEventResponses, buildEventResponse, decryptCapturedEventResponses } from './event-responses';

const ownJid = '10000@s.whatsapp.net';
const key = { id: 'response-1', remoteJid: '123@g.us', participant: '20000:2@s.whatsapp.net', fromMe: false };
const timestampMs = 1790000000000;
const going = { response: proto.Message.EventResponseMessage.EventResponseType.GOING, timestampMs, extraGuestCount: 2 };

test('rc13 runtime and protobuf persisted responses normalize to the same attendance', () => {
  const runtime = captureEventResponse({ eventResponseMessageKey: key, response: going, senderTimestampMs: timestampMs }, ownJid);
  const persisted = proto.EventResponse.decode(proto.EventResponse.encode({ eventResponseMessageKey: key, eventResponseMessage: going, timestampMs }).finish());
  assert.deepEqual(captureEventResponse(persisted, ownJid), runtime);
  assert.deepEqual(runtime, { messageId: 'response-1', responderJid: '20000@s.whatsapp.net', fromMe: false, timestampMs, attendance: 'going', extraGuestCount: 2 });
});

test('own response uses own account identity, and LID never becomes a phone', () => {
  const own = captureEventResponse({ eventResponseMessageKey: { ...key, fromMe: true }, response: going }, '10000:5@s.whatsapp.net');
  assert.equal(own?.responderJid, ownJid);
  const lid = captureEventResponse({ eventResponseMessageKey: { ...key, participant: '20000@lid' }, response: going }, ownJid);
  assert.equal(lid?.responderJid, '20000@lid');
  assert.equal(captureEventResponse({ eventResponseMessageKey: { ...key, participant: null }, response: going }, ownJid), null);
});

test('invalid enums, missing timestamps, unsafe integers and negative guests are not votes', () => {
  for (const response of [{ ...going, response: 9 }, { ...going, timestampMs: undefined }, { ...going, timestampMs: Number.MAX_SAFE_INTEGER + 1 }, { ...going, timestampMs: -1 }, { ...going, extraGuestCount: -1 }]) {
    assert.equal(captureEventResponse({ eventResponseMessageKey: key, response }, ownJid), null);
  }
  assert.equal(captureEventResponse({ eventResponseMessageKey: key, eventResponse: 'GOING' }, ownJid), null);
});

test('out of order updates, duplicate delivery and attendance withdrawal yield one latest answer per responder', () => {
  const first = captureEventResponse({ eventResponseMessageKey: key, response: going }, ownJid)!;
  const second = captureEventResponse({ eventResponseMessageKey: { ...key, id: 'response-2' }, response: { ...going, response: 3, timestampMs: timestampMs + 1 } }, ownJid)!;
  const own = captureEventResponse({ eventResponseMessageKey: { ...key, id: 'own', fromMe: true }, response: going }, ownJid)!;
  const expected = { counts: { going: 1, not_going: 0, maybe: 1 }, extraGuests: 2, selectedByMe: 'going', selectedExtraGuestCount: 2, capturedResponders: 2, availability: 'local_partial' };
  assert.deepEqual(aggregateEventResponses([second, first, own, first, second]), expected);
  const withdrawn = { ...second, messageId: 'response-3', timestampMs: timestampMs + 2, attendance: 'unknown' as const };
  assert.deepEqual(aggregateEventResponses([first, withdrawn, second]).counts, { going: 0, not_going: 0, maybe: 0 });
});

test('equal timestamps have deterministic ordering and non-going responses never count guests', () => {
  const first = captureEventResponse({ eventResponseMessageKey: key, response: going }, ownJid)!;
  const second = captureEventResponse({ eventResponseMessageKey: { ...key, id: 'response-2' }, response: { ...going, response: 2 } }, ownJid)!;
  assert.equal(second.extraGuestCount, 0);
  assert.deepEqual(aggregateEventResponses([first, second]), aggregateEventResponses([second, first]));
  assert.equal(aggregateEventResponses([second]).counts.not_going, 1);
});

test('encrypted RSVP round-trips with the installed rc13 decryptor and binds responder identity', () => {
  const eventSecret = Buffer.alloc(32, 7);
  for (const attendance of ['going', 'not_going', 'maybe'] as const) {
    const result = buildEventResponse({ eventKey: key, eventSecret, creatorJid: '20000@s.whatsapp.net', responderJid: ownJid, attendance, timestampMs });
    const encrypted = result.encEventResponseMessage!;
    const context = { eventEncKey: eventSecret, eventCreatorJid: '20000@s.whatsapp.net', eventMsgId: key.id, responderJid: ownJid };
    const decrypted = decryptEventResponse(encrypted, context);
    assert.equal(decrypted.response, { going: 1, not_going: 2, maybe: 3 }[attendance]);
    assert.equal(Number(decrypted.timestampMs), timestampMs);
    assert.throws(() => decryptEventResponse(encrypted, { ...context, responderJid: '99999@s.whatsapp.net' }));
    assert.throws(() => decryptEventResponse(encrypted, { ...context, eventMsgId: 'another-event' }));
  }
});

test('RSVP refuses unresolved identities and missing secrets before constructing a send', () => {
  const input = { eventKey: key, eventSecret: Buffer.alloc(32), creatorJid: '20000@s.whatsapp.net', responderJid: ownJid, attendance: 'going' as const, timestampMs };
  for (const override of [{ creatorJid: '20000@lid' }, { responderJid: '10000@lid' }, { eventSecret: Buffer.alloc(31) }, { iv: Buffer.alloc(8) }, { extraGuestCount: -1 }, { timestampMs: NaN }]) {
    assert.throws(() => buildEventResponse({ ...input, ...override }));
  }
});

test('RSVP rejects unknown attendance strings including inherited object properties', () => {
  const input = { eventKey: key, eventSecret: Buffer.alloc(32), creatorJid: '20000@s.whatsapp.net', responderJid: ownJid, timestampMs };
  for (const attendance of ['toString', 'constructor', '__proto__', '', 'unknown']) {
    assert.throws(() => buildEventResponse({ ...input, attendance: attendance as 'going' }), /Invalid event response input/);
  }
});

test('captured encrypted replies resolve LIDs and isolate the event and conversation', async () => {
  const eventSecret = Buffer.alloc(32, 9);
  const eventKey = {id: 'event-1', remoteJid: '123@g.us'};
  const creatorJid = '20000@s.whatsapp.net';
  const responderJid = '30000@s.whatsapp.net';
  const content = buildEventResponse({eventKey, eventSecret, creatorJid, responderJid, attendance: 'going', timestampMs});
  const update = {key: {id: 'reply-1', remoteJid: '123@g.us', participant: '777@lid'}, content};
  const resolved: string[] = [];
  const context = {eventKey, eventSecret, creatorJid, ownJid, resolvePhoneJid: async (jid: string) => {resolved.push(jid); return responderJid;}};
  const result = await decryptCapturedEventResponses([
    update,
    {...update, key: {...update.key, remoteJid: '999@g.us'}},
    {...update, content: buildEventResponse({eventKey: {...eventKey, id: 'other-event'}, eventSecret, creatorJid, responderJid, attendance: 'going', timestampMs})},
  ], context);
  assert.deepEqual(resolved, ['777@lid']);
  assert.equal(result.undecryptable, 0);
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].responderJid, responderJid);
  assert.equal(result.responses[0].attendance, 'going');
  assert.equal((await decryptCapturedEventResponses([update], {...context, resolvePhoneJid: async () => null})).undecryptable, 1);
  assert.equal((await decryptCapturedEventResponses([update], {...context, eventSecret: Buffer.alloc(32, 1)})).undecryptable, 1);
});

test('captured own RSVP uses the connector account identity and supports ephemeral envelopes', async () => {
  const eventSecret = Buffer.alloc(32, 3);
  const eventKey = {id: 'event-2', remoteJid: '123@g.us'};
  const creatorJid = '20000@s.whatsapp.net';
  const content = buildEventResponse({eventKey, eventSecret, creatorJid, responderJid: ownJid, attendance: 'maybe', timestampMs});
  const result = await decryptCapturedEventResponses([{
    key: {id: 'own-reply', remoteJid: '123@g.us', fromMe: true}, content: {ephemeralMessage: {message: content}},
  }], {eventKey, eventSecret, creatorJid, ownJid: '10000:5@s.whatsapp.net', resolvePhoneJid: async () => {throw new Error('unexpected lookup');}});
  assert.equal(result.undecryptable, 0);
  assert.equal(result.responses[0].fromMe, true);
  assert.equal(aggregateEventResponses(result.responses).selectedByMe, 'maybe');
});
