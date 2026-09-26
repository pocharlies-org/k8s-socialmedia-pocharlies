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
  normalizeCapabilityAction,
  serializeDurableValue,
  deserializeDurableValue,
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
  const poll = buildPollMessage({ name: 'Availability', values: ['Yes', 'No'], selectableCount: 1 });
  assert.deepEqual(poll, { poll: { name: 'Availability', values: ['Yes', 'No'], selectableCount: 1 } });

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
    buildPresenceSnapshot('34600@c.us', { lastKnownPresence: 'unavailable', lastSeen: 1_700_000_000 }),
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
    (error: unknown) => error instanceof CapabilityError && error.code === 'INVALID_CAPABILITY_INPUT'
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
