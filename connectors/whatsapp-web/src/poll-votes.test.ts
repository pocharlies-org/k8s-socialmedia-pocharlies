/**
 * Polls and events (fase 3 / PR-7) — the pure part: request validation, poll /
 * event definitions and the vote / response crypto against Baileys' own
 * decryptPollVote / decryptEventResponse. Ported from the NAS fork's
 * poll-votes.test.ts, event-responses.test.ts and whatsapp-capabilities.test.ts
 * (poll parts), adapted to prod's API.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptEventResponse, decryptPollVote, proto } from '@whiskeysockets/baileys';
import {
  buildPollContent,
  buildPollVoteContent,
  cryptoUserJid,
  decryptPollVoteWith,
  int64Ms,
  keyAuthorCandidates,
  messageSecretOf,
  optionHash,
  parsePollDefinition,
  PollEventInputError,
  pollSigningPair,
  selectedOptionNames,
  validatePollInput,
  validatePollSelection,
} from './poll-votes';
import {
  buildEventContent,
  buildEventResponseContent,
  decryptEventResponseWith,
  parseEventDefinition,
  validateEventInput,
  validateEventLocation,
  validateEventResponse,
} from './event-responses';
import { aggregateEventResults, aggregatePollResults } from './poll-event-store';

const SECRET = new Uint8Array(32).fill(7);
const GROUP = '120363000@g.us';
const OWN = { pn: '34999@s.whatsapp.net', lid: '9999@lid' };

function rejects(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof PollEventInputError, `not an input error: ${String(error)}`);
    assert.equal(error.status, 400);
    assert.equal(error.failureClass, 'invalid_request');
    assert.match(error.message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Poll requests
// ---------------------------------------------------------------------------

test('poll input: 2..12 trimmed, non-repeated options; selectableCount 0 (any) .. n', () => {
  assert.deepEqual(validatePollInput({ name: ' ¿Cena? ', options: [' Sí', 'No '] }), {
    name: '¿Cena?',
    options: ['Sí', 'No'],
    selectableCount: 0,
  });
  assert.equal(
    validatePollInput({ name: 'q', options: ['a', 'b', 'c'], selectableCount: 1 }).selectableCount,
    1
  );
  rejects(() => validatePollInput({ name: 'q', options: ['solo'] }), /between 2 and 12/);
  rejects(
    () =>
      validatePollInput({
        name: 'q',
        options: Array.from({ length: 13 }, (_, i) => `o${i}`),
      }),
    /between 2 and 12/
  );
  rejects(() => validatePollInput({ name: '', options: ['a', 'b'] }), /question/);
  rejects(() => validatePollInput({ name: 'q', options: 'a,b' }), /list/);
  rejects(() => validatePollInput({ name: 'q', options: ['a', ' '] }), /Option 2 is empty/);
  rejects(() => validatePollInput({ name: 'q', options: ['a', 3] }), /Option 2/);
  rejects(() => validatePollInput({ name: 'q', options: ['a', 'a '] }), /cannot repeat/);
  rejects(() => validatePollInput({ name: 'q', options: ['a', 'x'.repeat(101)] }), /100/);
  rejects(() => validatePollInput({ name: 'q'.repeat(256), options: ['a', 'b'] }), /255/);
  for (const selectableCount of [3, -1, 1.5, 'x']) {
    rejects(
      () => validatePollInput({ name: 'q', options: ['a', 'b'], selectableCount }),
      /selectableCount/
    );
  }
  assert.deepEqual(buildPollContent({ name: 'q', options: ['a', 'b'], selectableCount: 1 }), {
    poll: { name: 'q', values: ['a', 'b'], selectableCount: 1 },
  });
});

test('poll definitions from every creation variant; the secret from messageContextInfo', () => {
  const options = [{ optionName: 'Uno' }, { optionName: 'Dos' }];
  for (const variant of [
    'pollCreationMessage',
    'pollCreationMessageV2',
    'pollCreationMessageV3',
    'pollCreationMessageV5',
  ]) {
    const message = {
      messageContextInfo: { messageSecret: SECRET },
      [variant]: { name: 'Q', options, selectableOptionsCount: 1 },
    };
    assert.deepEqual(parsePollDefinition(message), {
      question: 'Q',
      options: ['Uno', 'Dos'],
      selectableCount: 1,
    });
    assert.deepEqual(messageSecretOf(message), SECRET);
  }
  const wrapped = {
    ephemeralMessage: {
      message: {
        messageContextInfo: { messageSecret: SECRET },
        pollCreationMessage: { name: 'Q', options, selectableOptionsCount: 0 },
      },
    },
  };
  assert.equal(parsePollDefinition(wrapped)?.selectableCount, 0);
  assert.deepEqual(messageSecretOf(wrapped), SECRET);
  const v4 = { pollCreationMessageV4: { message: { pollCreationMessage: { name: 'Q', options } } } };
  assert.deepEqual(parsePollDefinition(v4)?.options, ['Uno', 'Dos']);
  // A stored (BufferJSON-revived / base64) secret works too; a short one does not.
  assert.deepEqual(
    messageSecretOf({ messageContextInfo: { messageSecret: Buffer.from(SECRET).toString('base64') } }),
    SECRET
  );
  assert.equal(messageSecretOf({ messageContextInfo: { messageSecret: new Uint8Array(8) } }), null);
  assert.equal(parsePollDefinition({ conversation: 'hola' }), null);
  assert.equal(parsePollDefinition({ pollCreationMessage: { name: 'Q', options: [] } }), null);
});

test('vote selection: exact names, no repeats, at most selectableCount; [] retracts', () => {
  const single = { question: 'Q', options: ['Uno', 'Dos', 'Tres'], selectableCount: 1 };
  const multi = { ...single, selectableCount: 0 };
  assert.deepEqual(validatePollSelection(single, ['Dos']), ['Dos']);
  assert.deepEqual(validatePollSelection(single, []), [], 'retract');
  assert.deepEqual(validatePollSelection(multi, ['Uno', 'Tres']), ['Uno', 'Tres']);
  rejects(() => validatePollSelection(single, ['Uno', 'Dos']), /at most 1/);
  rejects(() => validatePollSelection(multi, ['Uno', 'Uno']), /repeat/);
  rejects(() => validatePollSelection(multi, [' Uno']), /Unknown poll option/);
  rejects(() => validatePollSelection(multi, 'Uno'), /list/);
  rejects(() => validatePollSelection(multi, [3]), /non-empty strings/);
});

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

test('identities: author candidates by key, the whatsmeow rule for our vote', () => {
  assert.equal(cryptoUserJid('34600@c.us'), '34600@s.whatsapp.net');
  assert.equal(cryptoUserJid('34600:12@s.whatsapp.net'), '34600@s.whatsapp.net');
  assert.equal(cryptoUserJid(GROUP), null);
  assert.deepEqual(
    keyAuthorCandidates(
      { remoteJid: GROUP, participant: '2222@lid', participantAlt: '34600@s.whatsapp.net' },
      OWN
    ),
    ['2222@lid', '34600@s.whatsapp.net']
  );
  assert.deepEqual(
    keyAuthorCandidates({ remoteJid: '1111@lid', remoteJidAlt: '34600@s.whatsapp.net' }, OWN),
    ['1111@lid', '34600@s.whatsapp.net']
  );
  assert.deepEqual(keyAuthorCandidates({ remoteJid: GROUP, fromMe: true }, OWN), [
    '9999@lid',
    '34999@s.whatsapp.net',
  ]);

  // Someone's poll in a LID group: creator as addressed, we vote with our LID.
  assert.deepEqual(pollSigningPair({ remoteJid: GROUP, participant: '2222@lid' }, OWN, true), {
    creator: '2222@lid',
    voter: '9999@lid',
  });
  // A phone-addressed poll: phone jids on both sides.
  assert.deepEqual(
    pollSigningPair({ remoteJid: GROUP, participant: '34600@s.whatsapp.net' }, OWN, false),
    { creator: '34600@s.whatsapp.net', voter: '34999@s.whatsapp.net' }
  );
  assert.deepEqual(pollSigningPair({ remoteJid: '34600@s.whatsapp.net' }, OWN, false), {
    creator: '34600@s.whatsapp.net',
    voter: '34999@s.whatsapp.net',
  });
  // Our own poll: our identity in the chat's addressing mode.
  assert.deepEqual(pollSigningPair({ remoteJid: GROUP, fromMe: true }, OWN, true), {
    creator: '9999@lid',
    voter: '9999@lid',
  });
  assert.deepEqual(pollSigningPair({ remoteJid: GROUP, fromMe: true }, OWN, false), {
    creator: '34999@s.whatsapp.net',
    voter: '34999@s.whatsapp.net',
  });
  // No LID known: fall back to the phone jid; no participant: no pair.
  assert.deepEqual(
    pollSigningPair({ remoteJid: GROUP, participant: '2222@lid' }, { pn: OWN.pn, lid: null }, true),
    { creator: '2222@lid', voter: '34999@s.whatsapp.net' }
  );
  assert.equal(pollSigningPair({ remoteJid: GROUP }, OWN, true), null);
});

// ---------------------------------------------------------------------------
// Vote crypto
// ---------------------------------------------------------------------------

test("our vote is readable by Baileys' own decryptPollVote (and carries the creation key)", () => {
  const creationKey = { remoteJid: GROUP, id: 'POLL1', fromMe: false, participant: '2222@lid' };
  const content = buildPollVoteContent({
    creationKey,
    secret: SECRET,
    creator: '2222@lid',
    voter: '9999@lid',
    options: ['Dos', 'Uno'],
    senderTimestampMs: 1_790_000_000_000,
  });
  const update = content.pollUpdateMessage!;
  assert.deepEqual(update.pollCreationMessageKey, {
    remoteJid: GROUP,
    fromMe: false,
    id: 'POLL1',
    participant: '2222@lid',
  });
  assert.equal(update.senderTimestampMs, 1_790_000_000_000);
  assert.equal((update.vote!.encIv as Uint8Array).length, 12);
  const decrypted = decryptPollVote(
    { encPayload: update.vote!.encPayload as Uint8Array, encIv: update.vote!.encIv as Uint8Array },
    { pollCreatorJid: '2222@lid', pollMsgId: 'POLL1', pollEncKey: SECRET, voterJid: '9999@lid' }
  );
  assert.deepEqual(
    (decrypted.selectedOptions || []).map(o => Buffer.from(o).toString('hex')),
    [optionHash('Dos'), optionHash('Uno')]
  );
});

test('decrypting tries every identity pair; a wrong secret or identity yields null', () => {
  const vote = buildPollVoteContent({
    creationKey: { remoteJid: GROUP, id: 'POLL1', participant: '2222@lid' },
    secret: SECRET,
    creator: '34600@s.whatsapp.net',
    voter: '34611@s.whatsapp.net',
    options: ['No'],
    senderTimestampMs: 1,
  }).pollUpdateMessage!.vote;
  const found = decryptPollVoteWith(vote, {
    pollId: 'POLL1',
    secret: SECRET,
    creators: ['2222@lid', '34600@s.whatsapp.net'],
    voters: ['3333@lid', '34611@s.whatsapp.net'],
  });
  assert.deepEqual(found, {
    hashes: [optionHash('No')],
    creator: '34600@s.whatsapp.net',
    voter: '34611@s.whatsapp.net',
  });
  assert.equal(
    decryptPollVoteWith(vote, {
      pollId: 'POLL1',
      secret: new Uint8Array(32).fill(1),
      creators: ['34600@s.whatsapp.net'],
      voters: ['34611@s.whatsapp.net'],
    }),
    null
  );
  assert.equal(
    decryptPollVoteWith(vote, {
      pollId: 'POLL1',
      secret: SECRET,
      creators: ['2222@lid'],
      voters: ['3333@lid'],
    }),
    null
  );
  assert.equal(decryptPollVoteWith(undefined, { pollId: 'P', secret: SECRET, creators: [], voters: [] }), null);
  // A retract round-trips as an empty selection.
  const retract = buildPollVoteContent({
    creationKey: { remoteJid: GROUP, id: 'POLL1' },
    secret: SECRET,
    creator: 'a@lid',
    voter: 'b@lid',
    options: [],
    senderTimestampMs: 2,
  }).pollUpdateMessage!.vote;
  assert.deepEqual(
    decryptPollVoteWith(retract, { pollId: 'POLL1', secret: SECRET, creators: ['a@lid'], voters: ['b@lid'] })
      ?.hashes,
    []
  );
});

test('hashes map back to option names; unknown hashes are kept apart', () => {
  const definition = { question: 'Q', options: ['Uno', 'Dos'], selectableCount: 0 };
  assert.deepEqual(selectedOptionNames(definition, [optionHash('Dos'), 'ff'.repeat(32)]), {
    names: ['Dos'],
    unknown: ['ff'.repeat(32)],
  });
  assert.equal(int64Ms({ low: 5, high: 0 }), 5);
  assert.equal(int64Ms('1790000000000'), 1_790_000_000_000);
  assert.equal(int64Ms(0), undefined);
});

test('aggregation: counts per option, voters, our vote; unknown options ignored', () => {
  const results = aggregatePollResults(
    { question: 'Q', options: ['Uno', 'Dos'], selectableCount: 0 },
    [
      { voterJid: 'a@lid', options: ['Uno', 'Dos'], hashes: [], fromMe: false, votedAt: null },
      { voterJid: 'b@lid', options: ['Dos'], hashes: [], fromMe: false, votedAt: null },
      { voterJid: 'me@c.us', options: ['Dos'], hashes: [], fromMe: true, votedAt: null },
      { voterJid: 'c@lid', options: ['Borrada'], hashes: [], fromMe: false, votedAt: null },
    ]
  );
  assert.deepEqual(
    results.options.map(o => [o.name, o.votes]),
    [
      ['Uno', 1],
      ['Dos', 3],
    ]
  );
  assert.equal(results.totalVoters, 3);
  assert.deepEqual(results.myVote, ['Dos']);
  assert.deepEqual(results.options[1].voters[2], { jid: 'me@c.us', fromMe: true });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test('event input: name, ISO / epoch-ms times, end after start, place, call, guests', () => {
  const event = validateEventInput({
    name: ' Partida ',
    description: ' en el campo ',
    startTime: '2026-10-04T09:00:00Z',
    endTime: 1_791_190_800_000,
    location: 'Campo Norte',
    call: 'video',
    extraGuestsAllowed: true,
  });
  assert.equal(event.name, 'Partida');
  assert.equal(event.description, 'en el campo');
  assert.equal(event.startTime.toISOString(), '2026-10-04T09:00:00.000Z');
  assert.equal(event.endTime?.getTime(), 1_791_190_800_000);
  assert.deepEqual(event.location, { name: 'Campo Norte' });
  assert.equal(event.call, 'video');
  assert.deepEqual(buildEventContent(event), {
    event: {
      name: 'Partida',
      description: 'en el campo',
      startDate: event.startTime,
      endDate: event.endTime,
      location: { name: 'Campo Norte' },
      call: 'video',
      extraGuestsAllowed: true,
    },
  });
  rejects(() => validateEventInput({ startTime: '2026-10-04T09:00:00Z' }), /name/);
  rejects(() => validateEventInput({ name: 'x' }), /startTime is required/);
  rejects(() => validateEventInput({ name: 'x', startTime: 'mañana' }), /ISO-8601/);
  rejects(() => validateEventInput({ name: 'x', startTime: 1_790_000_000 }), /before 2020/);
  rejects(
    () =>
      validateEventInput({ name: 'x', startTime: '2026-10-04T09:00:00Z', endTime: '2026-10-04T08:00:00Z' }),
    /endTime cannot be before/
  );
  rejects(() => validateEventInput({ name: 'x', startTime: '2026-10-04T09:00:00Z', call: 'zoom' }), /call/);
  rejects(
    () => validateEventInput({ name: 'x', startTime: '2026-10-04T09:00:00Z', extraGuestsAllowed: 'yes' }),
    /boolean/
  );
  assert.deepEqual(validateEventLocation({ degreesLatitude: '41.4', degreesLongitude: 2.17 }), {
    degreesLatitude: 41.4,
    degreesLongitude: 2.17,
  });
  rejects(() => validateEventLocation({ degreesLatitude: 41 }), /both coordinates/);
  rejects(() => validateEventLocation({ degreesLatitude: 91, degreesLongitude: 0 }), /out of range/);
  assert.equal(validateEventLocation({ name: ' ' }), undefined, 'a blank place is no place');
});

test('event responses: going/not_going/maybe; extra guests only when going', () => {
  assert.deepEqual(validateEventResponse('going', 2), { response: 'going', extraGuestCount: 2 });
  assert.deepEqual(validateEventResponse('maybe', undefined), { response: 'maybe', extraGuestCount: 0 });
  rejects(() => validateEventResponse('yes', 0), /going, not_going or maybe/);
  rejects(() => validateEventResponse('maybe', 1), /only goes with response "going"/);
  rejects(() => validateEventResponse('going', -1), /extraGuestCount/);
  rejects(() => validateEventResponse('going', 101), /extraGuestCount/);
});

test('event definitions read the proto fields (seconds → ms)', () => {
  const definition = parseEventDefinition({
    messageContextInfo: { messageSecret: SECRET },
    eventMessage: {
      name: 'Partida',
      description: 'd',
      startTime: 1_791_190_800,
      endTime: 1_791_198_000,
      location: { name: 'Campo', degreesLatitude: 41.4, degreesLongitude: 2.17 },
      joinLink: 'https://call.whatsapp.com/video/x',
      isCanceled: false,
      extraGuestsAllowed: true,
    },
  });
  assert.deepEqual(definition, {
    name: 'Partida',
    description: 'd',
    startTime: 1_791_190_800_000,
    endTime: 1_791_198_000_000,
    location: { name: 'Campo', degreesLatitude: 41.4, degreesLongitude: 2.17 },
    joinLink: 'https://call.whatsapp.com/video/x',
    isCanceled: false,
    extraGuestsAllowed: true,
  });
  assert.equal(parseEventDefinition({ conversation: 'x' }), null);
});

test("our response is readable by Baileys' decryptEventResponse; inbound tries every pair", () => {
  const eventKey = { remoteJid: GROUP, id: 'EV1', fromMe: false, participant: '2222@lid' };
  const content = buildEventResponseContent({
    eventKey,
    secret: SECRET,
    creator: '34600@s.whatsapp.net',
    responder: '34999@s.whatsapp.net',
    response: 'going',
    extraGuestCount: 2,
    timestampMs: 1_790_000_000_000,
  });
  const enc = content.encEventResponseMessage!;
  assert.deepEqual(enc.eventCreationMessageKey, eventKey);
  const decoded = decryptEventResponse(
    { encPayload: enc.encPayload as Uint8Array, encIv: enc.encIv as Uint8Array },
    {
      eventCreatorJid: '34600@s.whatsapp.net',
      eventMsgId: 'EV1',
      eventEncKey: SECRET,
      responderJid: '34999@s.whatsapp.net',
    }
  );
  assert.equal(decoded.response, proto.Message.EventResponseMessage.EventResponseType.GOING);
  assert.equal(decoded.extraGuestCount, 2);

  assert.deepEqual(
    decryptEventResponseWith(enc, {
      eventId: 'EV1',
      secret: SECRET,
      creators: ['2222@lid', '34600@s.whatsapp.net'],
      responders: ['9999@lid', '34999@s.whatsapp.net'],
    }),
    {
      response: 'going',
      timestampMs: 1_790_000_000_000,
      extraGuestCount: 2,
      creator: '34600@s.whatsapp.net',
      responder: '34999@s.whatsapp.net',
    }
  );
  assert.equal(
    decryptEventResponseWith(enc, { eventId: 'EV1', secret: SECRET, creators: ['2222@lid'], responders: ['9999@lid'] }),
    null
  );
});

test('event aggregation: counts, extra guests of the ones going, our answer', () => {
  const results = aggregateEventResults([
    { responderJid: 'a@lid', response: 'going', extraGuestCount: 2, fromMe: false, respondedAt: null },
    { responderJid: 'b@lid', response: 'maybe', extraGuestCount: 0, fromMe: false, respondedAt: null },
    { responderJid: 'c@lid', response: 'not_going', extraGuestCount: 0, fromMe: false, respondedAt: null },
    { responderJid: 'me@c.us', response: 'going', extraGuestCount: 0, fromMe: true, respondedAt: null },
  ]);
  assert.deepEqual(results.counts, { going: 2, maybe: 1, not_going: 1 });
  assert.equal(results.extraGuests, 2);
  assert.equal(results.myResponse, 'going');
  assert.equal(results.responses.length, 4);
});
