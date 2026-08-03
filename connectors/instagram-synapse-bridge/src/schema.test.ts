import assert from 'node:assert/strict';
import test from 'node:test';
import { validateInstagramDmEvent } from './schema';

const valid = {
  platform: 'instagram',
  account: 'skirmshop',
  eventType: 'dm',
  senderId: 'sender-opaque-id',
  conversationId: 'conversation-opaque-id',
  messageId: 'message-opaque-id',
  timestamp: '2026-08-02T12:00:00.000Z',
  text: 'not logged by this test or service',
};

test('only the exact Skirmshop inbound-DM contract is accepted', () => {
  assert.deepEqual(validateInstagramDmEvent(valid), valid);
  assert.equal(validateInstagramDmEvent({ ...valid, account: 'barbelpapis' }), null);
  assert.equal(validateInstagramDmEvent({ ...valid, eventType: 'comment' }), null);
  assert.equal(validateInstagramDmEvent({ ...valid, senderId: '' }), null);
  assert.equal(validateInstagramDmEvent({ ...valid, text: '' }), null);
  assert.equal(validateInstagramDmEvent({ ...valid, text: undefined }), null);
  assert.equal(validateInstagramDmEvent({ ...valid, timestamp: 'not-a-date' }), null);
  assert.equal(validateInstagramDmEvent(['not', 'an', 'event']), null);
});
