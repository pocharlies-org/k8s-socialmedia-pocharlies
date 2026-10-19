import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_LIST_ACTIVE_SQL,
  CHAT_LIST_ARCHIVED_SQL,
  CHAT_LIST_SQL,
  MESSAGE_LIST_SQL,
  isJidPlaceholder,
  readableChatName,
  resolveChatName,
  resolveMessageSenderName,
} from '../lib/chat-names.mjs';

test('placeholder detection handles account-scoped and Baileys JIDs', () => {
  assert.equal(isJidPlaceholder('professional:123@lid', 'professional:123@lid'), true);
  assert.equal(isJidPlaceholder('123@lid', 'professional:123@lid'), true);
  assert.equal(isJidPlaceholder('123@g.us', '123@g.us'), true);
  assert.equal(isJidPlaceholder('Agenda', '123@lid'), false);
});

test('direct chats fall back to contact or push name, while groups keep their subject', () => {
  assert.equal(
    resolveChatName({
      id: 'professional:123@lid',
      conversationName: '123@lid',
      contactName: 'Agenda',
      pushName: 'Perfil',
    }),
    'Agenda'
  );
  assert.equal(
    resolveChatName({
      id: '120363@g.us',
      isGroup: true,
      conversationName: '120363@g.us',
      contactName: 'Participante',
      pushName: 'Perfil',
    }),
    '120363@g.us'
  );
});

test('outbound messages do not borrow the operator name', () => {
  assert.equal(
    resolveMessageSenderName({
      fromMe: true,
      senderName: 'Operador',
      senderPushName: 'Operador',
      senderId: 'me@lid',
    }),
    null
  );
  assert.equal(
    resolveMessageSenderName({
      senderName: 'Agenda',
      senderPushName: 'Perfil',
      senderId: '123@lid',
    }),
    'Agenda'
  );
});

test('unknown direct contacts show a phone number without provider suffix', () => {
  assert.equal(readableChatName({ id: 'personal:34600123456@c.us', name: '34600123456@c.us', isGroup: false }), '+34600123456');
  assert.equal(readableChatName({ id: '34600123456@c.us', name: 'Agenda', isGroup: false }), 'Agenda');
  assert.equal(readableChatName({ id: '123@g.us', name: '123@g.us', isGroup: true }), '123@g.us');
});

test('SQL keeps account predicates and joins participant names by scoped id', () => {
  assert.match(CHAT_LIST_SQL, /c\.account = \$1/);
  assert.match(CHAT_LIST_SQL, /m\.account = \$1/);
  assert.match(CHAT_LIST_SQL, /p\.id = m\.sender_wa_id/);
  assert.match(CHAT_LIST_SQL, /m\.direction = 'INBOUND'/);
  assert.match(MESSAGE_LIST_SQL, /m\.conversation_id = ANY\(\$2::text\[\]\)/);
  assert.match(MESSAGE_LIST_SQL, /p\.account = m\.account/);
  assert.match(MESSAGE_LIST_SQL, /senderName/);
});

test('chat views filter archive state before limiting results', () => {
  assert.match(CHAT_LIST_ACTIVE_SQL, /WHERE c\.account = \$1[\s\S]*AND \(COALESCE\(c\.archived, false\) OR COALESCE\(pn_alias\.archived, false\)\) = false\s+ORDER BY[\s\S]*LIMIT 500$/);
  assert.match(CHAT_LIST_ARCHIVED_SQL, /WHERE c\.account = \$1[\s\S]*AND \(COALESCE\(c\.archived, false\) OR COALESCE\(pn_alias\.archived, false\)\) = true\s+ORDER BY/);
  assert.match(CHAT_LIST_ACTIVE_SQL, /m\.conversation_id = ANY\(array_prepend\(c\.id, COALESCE\(pn_alias\.ids/);
  assert.match(CHAT_LIST_ARCHIVED_SQL, /lid\.account = c\.account/);
  assert.doesNotMatch(CHAT_LIST_ARCHIVED_SQL, /LIMIT 500$/);
});

test('all chat views exclude channels and status without excluding broadcast lists', () => {
  for (const sql of [CHAT_LIST_SQL, CHAT_LIST_ACTIVE_SQL, CHAT_LIST_ARCHIVED_SQL]) {
    assert.match(sql, /c\.id !~ '@newsletter\$'/);
    assert.match(sql, /c\.id !~ '\(\^\|:\)status@broadcast\$'/);
    assert.doesNotMatch(sql, /c\.id !~ '@broadcast\$'/);
  }
});
