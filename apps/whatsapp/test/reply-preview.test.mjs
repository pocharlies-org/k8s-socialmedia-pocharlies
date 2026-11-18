import test from 'node:test';
import assert from 'node:assert/strict';
import { projectReplyPreview } from '../lib/reply-preview.mjs';
import { needsMessageRecovery, recoveryLabel, HISTORY_RECOVERY_WAIT_MS } from '../public/history-recovery.mjs';

const conversation = {id: 'personal:278919940984842@lid', name: '+34938395454', is_group: false};
const quote = (content = 'Your appointment Clinic') => ({reply_preview: content, reply_type: 'TEMPLATEMESSAGE', reply_from_id: 'personal:278919940984842@lid', reply_from: '278919940984842@lid'});
const row = {replyToMessageId: 'personal:original', replyAvailable: false};

test('captured business quote is readable with the established direct chat name', () => {
  assert.deepEqual(projectReplyPreview(row, quote(), conversation), {
    type: 'TEMPLATEMESSAGE', text: 'Your appointment Clinic', senderName: '+34938395454', available: true,
  });
  assert.equal(projectReplyPreview(row, quote('<b>Appointment</b>'), conversation).text, '<b>Appointment</b>');
});

test('quote fallback never exposes unknown LID, guesses group sender or revives locally hidden targets', () => {
  assert.equal(projectReplyPreview({...row, replyAvailable: true, replyText: 'Hello', replySenderName: 'other@lid'}, null, conversation).senderName, null);
  assert.equal(projectReplyPreview(row, quote(), {...conversation, is_group: true}).senderName, null);
  for (const [target, metadata] of [[row, {}], [{...row, replyLocallyDeleted: true}, quote()]]) {
    assert.deepEqual(projectReplyPreview(target, metadata, conversation), {type: null, text: '', senderName: null, available: false});
  }
});

test('captured business types do not solicit phone history but genuine placeholders do', () => {
  assert.equal(needsMessageRecovery([{type: 'TEMPLATEMESSAGE', text: '', attachments: []}]), false);
  assert.equal(needsMessageRecovery([{type: 'BUTTONSMESSAGE', text: '', attachments: []}]), false);
  assert.equal(needsMessageRecovery([{type: 'PLACEHOLDERMESSAGE', text: '', attachments: []}]), true);
  assert.equal(needsMessageRecovery([{type: 'TEXT', text: 'CONFIRMAR', attachments: []}]), false);
  assert.equal(HISTORY_RECOVERY_WAIT_MS, 30000);
  assert.match(recoveryLabel('timeout'), /no ha entregado nuevos mensajes/);
});
