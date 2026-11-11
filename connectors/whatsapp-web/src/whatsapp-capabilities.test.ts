import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proto } from '@whiskeysockets/baileys';
import {
  CapabilityError,
  buildChatModification,
  buildContactMessage,
  buildEventMessage,
  buildPollMessage,
  buildPresenceSnapshot,
  buildPrivacyUpdate,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX_LENGTH,
  POLL_QUESTION_MAX_LENGTH,
  normalizeCapabilityAction,
  serializeDurableValue,
  deserializeDurableValue,
  validateEventLocation,
  validatePollInput,
} from './whatsapp-capabilities';

test('chat modifications use the Baileys lastMessages contract', () => {
  const key = { remoteJid: '34600@s.whatsapp.net', id: 'msg-1', fromMe: false };
  const lastMessages = [{ key, messageTimestamp: 123 }];

  assert.deepEqual(buildChatModification('archive', true, lastMessages), {
    archive: true,
    lastMessages,
  });
  assert.deepEqual(buildChatModification('unarchive', undefined, lastMessages), {
    archive: false,
    lastMessages,
  });
  assert.deepEqual(buildChatModification('mute', 60_000, lastMessages), { mute: 60_000 });
  assert.deepEqual(buildChatModification('star', true, lastMessages, [{ id: 'msg-1' }]), {
    star: { messages: [{ id: 'msg-1' }], star: true },
  });
  assert.throws(
    () => buildChatModification('not-supported', true, lastMessages),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_UNSUPPORTED'
  );
});

test('poll, event, and contact payloads preserve typed Baileys fields', () => {
  const poll = buildPollMessage({
    name: 'Availability',
    values: ['Yes', 'No'],
    selectableCount: 1,
  });
  assert.deepEqual(poll, {
    poll: { name: 'Availability', values: ['Yes', 'No'], selectableCount: 1 },
  });

  const event = buildEventMessage({
    name: 'Release',
    description: 'Ship it',
    startDate: new Date('2026-09-23T10:00:00Z'),
    endDate: new Date('2026-09-23T11:00:00Z'),
  });
  assert.equal(event.event.name, 'Release');
  assert.equal(event.event.startDate.toISOString(), '2026-09-23T10:00:00.000Z');

  const contact = buildContactMessage({ displayName: 'Ada', phone: '+34600111222' });
  assert.equal(contact.contacts.contacts[0].displayName, 'Ada');
  assert.match(contact.contacts.contacts[0].vcard || '', /TEL;type=CELL;type=VOICE:\+34600111222/);
});

test('presence snapshots omit unknown lastSeen instead of inventing a timestamp', () => {
  assert.deepEqual(buildPresenceSnapshot('34600@c.us', { lastKnownPresence: 'available' }), {
    chatId: '34600@c.us',
    status: 'available',
  });
  assert.deepEqual(
    buildPresenceSnapshot('34600@c.us', {
      lastKnownPresence: 'unavailable',
      lastSeen: 1_700_000_000,
    }),
    { chatId: '34600@c.us', status: 'unavailable', lastSeen: 1_700_000_000 }
  );
});

test('privacy update validates only provider-supported values', () => {
  assert.deepEqual(buildPrivacyUpdate('lastSeen', 'contacts'), {
    method: 'updateLastSeenPrivacy',
    value: 'contacts',
  });
  assert.deepEqual(buildPrivacyUpdate('online', 'match_last_seen'), {
    method: 'updateOnlinePrivacy',
    value: 'match_last_seen',
  });
  assert.throws(
    () => buildPrivacyUpdate('lastSeen', 'invented'),
    (error: unknown) =>
      error instanceof CapabilityError && error.code === 'INVALID_CAPABILITY_INPUT'
  );
});

test('durable JSON round-trip preserves byte arrays used by media and message secrets', () => {
  const value = { bytes: Buffer.from([1, 2, 3]), nested: new Uint8Array([4, 5]) };
  const decoded = deserializeDurableValue(serializeDurableValue(value)) as typeof value;
  assert.equal(Buffer.isBuffer(decoded.bytes), true);
  assert.deepEqual(decoded.bytes, Buffer.from([1, 2, 3]));
  assert.equal(decoded.nested instanceof Uint8Array, true);
  assert.deepEqual(Buffer.from(decoded.nested), Buffer.from([4, 5]));

  // pg parses JSONB before the connector sees it, so exercise that path too.
  const pgJsonb = JSON.parse(serializeDurableValue(value));
  const rehydrated = deserializeDurableValue(pgJsonb) as typeof value;
  assert.equal(Buffer.isBuffer(rehydrated.bytes), true);
  assert.deepEqual(rehydrated.bytes, Buffer.from([1, 2, 3]));
  assert.equal(rehydrated.nested instanceof Uint8Array, true);
});

test('action aliases stay explicit and do not silently become sends', () => {
  assert.equal(normalizeCapabilityAction('mark-unread'), 'unread');
  assert.equal(normalizeCapabilityAction('archive'), 'archive');
  assert.equal(normalizeCapabilityAction('unarchive'), 'unarchive');
  assert.equal(normalizeCapabilityAction('unknown'), null);
  assert.equal(proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, 14);
});

const invalid = (error: unknown) =>
  error instanceof CapabilityError && error.code === 'INVALID_CAPABILITY_INPUT';

/**
 * The numbers the official FAQ states (question 255, up to 12 options, option
 * 100) are pinned here so a later "cleanup" cannot quietly widen them and start
 * producing polls the provider rejects after the relay.
 * https://faq.whatsapp.com/796470361614974
 */
test('poll limits match the published WhatsApp limits', () => {
  assert.deepEqual(
    {
      question: POLL_QUESTION_MAX_LENGTH,
      option: POLL_OPTION_MAX_LENGTH,
      minOptions: POLL_MIN_OPTIONS,
      maxOptions: POLL_MAX_OPTIONS,
    },
    { question: 255, option: 100, minOptions: 2, maxOptions: 12 }
  );
});

test('buildPollMessage refuses what the provider would refuse instead of trimming it down', () => {
  // The route is not the only caller: a caller that skips validation still
  // cannot put an out-of-band poll on the wire.
  assert.throws(
    () =>
      buildPollMessage({
        name: 'Comida?',
        values: Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_v, i) => `o${i}`),
      }),
    invalid
  );
  assert.throws(() => buildPollMessage({ name: 'Comida?', values: ['Pizza'] }), invalid);
  assert.throws(() => buildPollMessage({ name: 'Comida?', values: ['Pizza', ' Pizza '] }), invalid);
  assert.throws(
    () => buildPollMessage({ name: 'Comida?', values: ['Pizza', 'x'.repeat(101)] }),
    invalid
  );
  assert.throws(() => buildPollMessage({ name: '   ', values: ['Pizza', 'Sushi'] }), invalid);
  assert.throws(
    () => buildPollMessage({ name: 'Comida?', values: ['Pizza', 'Sushi'], selectableCount: 3 }),
    invalid
  );

  const widest = buildPollMessage({
    name: 'q'.repeat(POLL_QUESTION_MAX_LENGTH),
    values: ['x'.repeat(POLL_OPTION_MAX_LENGTH), ...Array.from({ length: 11 }, (_v, i) => `o${i}`)],
    selectableCount: POLL_MAX_OPTIONS,
  });
  assert.equal((widest.poll as { values: string[] }).values.length, POLL_MAX_OPTIONS);

  // The secret is the poll's encryption key, so a caller that supplies one keeps it.
  const secret = new Uint8Array(32).fill(4);
  assert.deepEqual(
    buildPollMessage({ name: 'Q', values: ['a', 'b'], messageSecret: secret }).poll,
    {
      name: 'Q',
      values: ['a', 'b'],
      messageSecret: secret,
    }
  );
  assert.equal(
    'messageSecret' in (buildPollMessage({ name: 'Q', values: ['a', 'b'] }).poll as object),
    false
  );
});

test('validatePollInput reports the offending field so the composer can show it', () => {
  for (const [values, field] of [
    [['Pizza'], 'values'],
    [['Pizza', ''], 'values'],
    [['Pizza', 'Pizza'], 'values'],
    [['Pizza', 'Sushi'], 'selectableCount'],
  ] as const) {
    assert.throws(
      () =>
        validatePollInput({
          name: 'Comida?',
          values,
          selectableCount: field === 'values' ? undefined : 9,
        }),
      invalid,
      String(field)
    );
  }
  assert.deepEqual(validatePollInput({ name: '  Comida?  ', values: [' Pizza ', 'Sushi'] }), {
    name: 'Comida?',
    values: ['Pizza', 'Sushi'],
  });
});

test('event location keeps a typed place separate from a map pin', () => {
  assert.equal(validateEventLocation(undefined), undefined);
  assert.equal(validateEventLocation(null), undefined);
  assert.deepEqual(validateEventLocation({ name: ' Bar Luna ' }), { name: 'Bar Luna' });
  assert.equal(validateEventLocation({ name: '   ' }), undefined);
  assert.deepEqual(validateEventLocation({ degreesLatitude: 0, degreesLongitude: 0 }), {
    degreesLatitude: 0,
    degreesLongitude: 0,
  });
  assert.deepEqual(
    validateEventLocation({ degreesLatitude: 40.4168, degreesLongitude: -3.7038, name: 'Oficina' }),
    { degreesLatitude: 40.4168, degreesLongitude: -3.7038, name: 'Oficina' }
  );
  for (const location of [
    'Bar Luna',
    ['Bar', 'Luna'],
    { degreesLatitude: 40.4 },
    { degreesLongitude: -3.7 },
    { degreesLatitude: 90.1, degreesLongitude: 0 },
    { degreesLatitude: -90.1, degreesLongitude: 0 },
    { degreesLatitude: 40.4, degreesLongitude: 180.1 },
    { degreesLatitude: 40.4, degreesLongitude: Number.NaN },
    { degreesLatitude: '', degreesLongitude: '' },
    { degreesLatitude: ' ', degreesLongitude: 0 },
    { degreesLatitude: false, degreesLongitude: false },
    { degreesLatitude: [], degreesLongitude: [] },
  ]) {
    assert.throws(() => validateEventLocation(location), invalid, JSON.stringify(location));
  }
});

test('buildEventMessage keeps one instant per field and drops blanks instead of sending them', () => {
  const start = new Date('2026-09-28T16:00:00Z');
  const same = buildEventMessage({ name: 'Cena', startDate: start, endDate: start });
  assert.equal(same.event.endDate.toISOString(), start.toISOString());
  assert.throws(
    () =>
      buildEventMessage({
        name: 'Cena',
        startDate: start,
        endDate: new Date('2026-09-28T15:59:59Z'),
      }),
    invalid
  );

  const drafted = buildEventMessage({
    name: ' Cena ',
    description: '   ',
    startDate: start,
    location: { name: 'Bar Luna' },
    call: 'audio',
    isCancelled: false,
    extraGuestsAllowed: true,
  });
  assert.equal(drafted.event.name, 'Cena');
  assert.equal('description' in drafted.event, false);
  assert.deepEqual(drafted.event.location, { name: 'Bar Luna' });
  assert.equal(drafted.event.call, 'audio');
  assert.equal(drafted.event.isCancelled, false);
  assert.equal(drafted.event.extraGuestsAllowed, true);
  assert.throws(
    () => buildEventMessage({ name: 'Cena', startDate: start, location: 'Bar Luna' }),
    invalid
  );
});
