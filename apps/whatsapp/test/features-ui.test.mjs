import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FeatureStore,
  attachmentItems,
  canMarkVisibleRead,
  chatIsArchived,
  chatIsFavorite,
  matchesChatView,
  newIncomingMessageIds,
  normalizeFeatureState,
  normalizePrivacySnapshot,
  privacyChanges,
  presenceLabel,
  visiblePresenceLabel,
  runScopedMutation,
  safePhotoUrl,
  shouldNotifyChatUpdate,
} from '../public/features-ui.mjs';
import { clearConfirmedDraft, renderMessage } from '../public/message-render.mjs';

function renderFixtureMessage(message) {
  const element = tag => ({ tag, className: '', dataset: {}, children: [], append(...items) { this.children.push(...items); }, setAttribute(name, value) { if (name === 'class') this.className = String(value); } });
  const document = { createElement: element, createElementNS: (_, tag) => element(tag), createDocumentFragment: () => element('fragment'), createTextNode: value => ({ textContent: value }) };
  const bubble = renderMessage(message, { document });
  const flatten = item => [item.className, item.textContent, ...(item.children || []).flatMap(flatten)].filter(Boolean).join(' ');
  return flatten(bubble);
}

test('Todos omits archived chats and provider flags override stale local state', () => {
  const local = { archivedChats: ['chat-1'], favoriteChats: ['chat-2'] };

  assert.equal(matchesChatView({ id: 'chat-1' }, 'all', local), false);
  assert.equal(matchesChatView({ id: 'chat-1' }, 'archived', local), true);
  assert.equal(chatIsArchived({ id: 'chat-1', archived: false }, local), false);
  assert.equal(matchesChatView({ id: 'chat-1', archived: false }, 'all', local), true);
  assert.equal(chatIsFavorite({ id: 'chat-2', favorite: false }, local), false);
  assert.equal(matchesChatView({ id: 'chat-2', favorite: false }, 'favorites', local), false);
  assert.equal(matchesChatView({ id: 'chat-2' }, 'list:work', { lists: [{ id: 'work', name: 'Trabajo', chatIds: ['chat-2'] }] }), true);
  assert.equal(matchesChatView({ id: 'chat-3' }, 'list:work', { lists: [{ id: 'work', name: 'Trabajo', chatIds: ['chat-2'] }] }), false);
});

test('sidebar has one feature filter row without the old duplicate controls', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /chat-filters|data-chat-filter/);
  assert.equal((ui.match(/node\('nav', 'feature-view-nav'\)/g) || []).length, 1);
  assert.match(ui, /search\?\.after\(views\)/);
  assert.match(ui, /views\.after\(archiveEntry\)/);
  assert.match(ui, /archiveBack\.onclick = \(\) => setView\('all'\)/);
  assert.doesNotMatch(ui, /\['Archivados', 'archived'\]/);
});

test('feature preferences normalize invalid entries and persist per account', () => {
  const calls = new Map();
  const storage = {
    getItem: key => calls.get(key) || null,
    setItem: (key, value) => calls.set(key, value),
  };
  const store = new FeatureStore(storage);
  const value = store.write('alpha', { archivedChats: ['a', 'a', '', null], lists: [{ id: 'l1', name: 'Trabajo', chatIds: ['a', 'a'] }], view: 'archived' });

  assert.deepEqual(value.archivedChats, ['a']);
  assert.deepEqual(value.lists, [{ id: 'l1', name: 'Trabajo', chatIds: ['a'] }]);
  assert.equal(store.read('alpha').view, 'archived');
  assert.equal(store.read('beta').archivedChats.length, 0);
  assert.deepEqual(normalizeFeatureState({ view: 'invalid', lists: [{ id: '', name: 'ignored' }] }).lists, []);
});

test('privacy snapshots normalize Baileys keys without inventing missing values', () => {
  assert.deepEqual(normalizePrivacySnapshot({ profile: 'contacts', last: 'none', readreceipts: 'all' }), {
    profile: 'contacts',
    lastSeen: 'none',
    readReceipts: 'true',
  });
  assert.deepEqual(normalizePrivacySnapshot({ profile: 'unknown', data: { profile: 'none' } }), {
    profile: 'none',
    lastSeen: null,
    readReceipts: null,
  });
  assert.deepEqual(normalizePrivacySnapshot({}), { profile: null, lastSeen: null, readReceipts: null });
});

test('privacy changes emit only changed connector fields and map receipt values', () => {
  assert.deepEqual(privacyChanges(
    { profile: 'all', lastSeen: 'contacts', readReceipts: true },
    { profile: 'none', lastSeen: 'contacts', readReceipts: 'false' },
  ), [
    { field: 'profilePicture', value: 'none' },
    { field: 'readReceipts', value: 'none' },
  ]);
  assert.deepEqual(privacyChanges(
    { profile: 'all', last: 'all', readreceipts: 'none' },
    { profile: 'all', lastSeen: 'none', readReceipts: 'false' },
  ), [{ field: 'lastSeen', value: 'none' }]);
  assert.deepEqual(privacyChanges({ profile: 'all' }, { profile: 'all', lastSeen: null, readReceipts: null }), []);
});

test('delayed archive, star and new-chat acknowledgements cannot refresh or alter a switched account', async () => {
  for (const action of ['archive', 'star', 'new-chat']) {
    let acknowledge;
    let activeAccount = 'alpha';
    const effects = [];
    const pending = runScopedMutation({
      request: () => new Promise(resolve => { acknowledge = resolve; }),
      isCurrent: () => activeAccount === 'alpha',
      refreshChats: async () => effects.push('chats'),
      refreshMessages: async () => effects.push('messages'),
      success: action,
      toast: () => effects.push('toast'),
      showError: () => effects.push('error'),
    });
    activeAccount = 'beta';
    acknowledge({ confirmed: true });
    assert.equal(await pending, null, `${action} returned a stale acknowledgement`);
    assert.deepEqual(effects, [], `${action} changed the new account`);
  }
});

test('a confirmed send clears the original account draft after a switch but preserves later edits', () => {
  const drafts = new Map([['alpha:chat', 'pending-confirmed'], ['beta:chat', 'beta draft']]);
  const composer = { value: 'beta draft' };
  assert.equal(clearConfirmedDraft(drafts, 'alpha:chat', 'pending-confirmed', 'beta:chat', composer), true);
  assert.equal(drafts.has('alpha:chat'), false);
  assert.equal(composer.value, 'beta draft');
  assert.equal(drafts.get('beta:chat'), 'beta draft');

  drafts.set('alpha:chat', 'edited after send');
  composer.value = 'edited after send';
  assert.equal(clearConfirmedDraft(drafts, 'alpha:chat', 'pending-confirmed', 'alpha:chat', composer), false);
  assert.equal(drafts.get('alpha:chat'), 'edited after send');
  assert.equal(composer.value, 'edited after send');

  drafts.set('alpha:chat', 'pending-confirmed');
  composer.value = 'pending-confirmed';
  assert.equal(clearConfirmedDraft(drafts, 'alpha:chat', 'pending-confirmed', 'alpha:chat', composer), true);
  assert.equal(composer.value, '');
});

test('visible read marking is scoped and never fires for hidden/background chats', () => {
  assert.equal(canMarkVisibleRead({ account: 'alpha', chat: 'chat', hidden: false, visibilityState: 'visible', lastMarked: '' }), true);
  assert.equal(canMarkVisibleRead({ account: 'alpha', chat: 'chat', hidden: true, visibilityState: 'hidden', lastMarked: '' }), false);
  assert.equal(canMarkVisibleRead({ account: 'alpha', chat: 'chat', hidden: false, visibilityState: 'hidden', lastMarked: '' }), false);
  assert.equal(canMarkVisibleRead({ account: 'alpha', chat: 'chat', hidden: false, visibilityState: 'visible', lastMarked: 'alpha:chat' }), false);
  assert.equal(canMarkVisibleRead({ account: '', chat: 'chat', hidden: false, visibilityState: 'visible', lastMarked: '' }), false);
});

test('notification baseline excludes existing backlog and only returns new incoming ids', () => {
  const existing = [{ id: 'old-in', fromMe: false }, { id: 'old-out', fromMe: true }];
  const current = [...existing, { id: 'new-in', fromMe: false }, { id: 'new-out', fromMe: true }];

  assert.deepEqual(newIncomingMessageIds(existing.map(item => item.id), current), ['new-in']);
  assert.deepEqual(newIncomingMessageIds(current.map(item => item.id), current), []);
  assert.equal(shouldNotifyChatUpdate({ timestamp: '2026-09-23T09:00:00Z', unread: 0 }, { timestamp: '2026-09-23T09:01:00Z', unread: 1 }, { hidden: true, permission: 'granted' }), true);
  assert.equal(shouldNotifyChatUpdate({ timestamp: '2026-09-23T09:00:00Z', unread: 0 }, { timestamp: '2026-09-23T09:01:00Z', unread: 1 }, { hidden: false, permission: 'granted' }), false);
  assert.equal(shouldNotifyChatUpdate({ timestamp: '2026-09-23T09:00:00Z', unread: 0 }, { timestamp: '2026-09-23T09:01:00Z', unread: 1 }, { hidden: true, permission: 'granted', muted: true }), false);
  assert.equal(shouldNotifyChatUpdate({ timestamp: '2026-09-23T09:00:00Z', unread: 0 }, { timestamp: '2026-09-23T09:01:00Z', unread: 0 }, { hidden: true, permission: 'granted' }), false);
  assert.equal(shouldNotifyChatUpdate({ timestamp: '2026-09-23T09:00:00Z', unread: 0 }, { timestamp: '2026-09-23T09:00:00Z', unread: 1 }, { hidden: true, permission: 'granted' }), false);
});

test('presence and photo helpers do not fabricate private data or allow external photo URLs', () => {
  assert.equal(presenceLabel({}), 'Estado no disponible');
  assert.equal(presenceLabel({ online: true }), 'En línea');
  assert.equal(presenceLabel({ state: 'available', available: true }), 'En línea');
  assert.equal(presenceLabel({ state: 'unavailable', available: true }), 'Desconectado');
  assert.match(presenceLabel({ lastSeen: '2026-09-23T09:00:00Z' }), /Última vez/);
  assert.equal(visiblePresenceLabel({ state: 'online', available: false }), '');
  assert.equal(visiblePresenceLabel({ state: 'online', available: true }), 'En línea');
  assert.equal(visiblePresenceLabel({ state: 'unknown', available: true }), '');
  assert.equal(safePhotoUrl('https://cdn.example.test/avatar.jpg', 'https://app.example.test/'), '');
  assert.equal(safePhotoUrl('/api/profile/photo?id=1', 'https://app.example.test/'), 'https://app.example.test/api/profile/photo?id=1');
  assert.equal(safePhotoUrl('javascript:alert(1)', 'https://app.example.test/'), '');
});

test('attachment gallery keeps message ownership and separates media from documents', () => {
  const messages = [{ id: 'm1', timestamp: '2026-09-23T09:00:00Z', attachments: [
    { url: '/api/media/1', mimeType: 'image/jpeg', name: 'photo.jpg' },
    { url: '/api/media/2', mimeType: 'application/pdf', name: 'brief.pdf' },
  ] }];

  assert.deepEqual(attachmentItems(messages, 'media').map(item => [item.name, item.messageId]), [['photo.jpg', 'm1']]);
  assert.deepEqual(attachmentItems(messages, 'documents').map(item => [item.name, item.messageId]), [['brief.pdf', 'm1']]);
});

test('received contact, poll, event, reply and edited metadata render visible labels', () => {
  const base = { id: 'message-1', fromMe: false };
  assert.match(renderFixtureMessage({ ...base, metadata: { kind: 'contact', contacts: [{ displayName: 'Persona', phone: '+34123456789' }] } }), /Contacto compartido.*Persona/);
  const poll = renderFixtureMessage({ ...base, text: '¿Vienes?', metadata: { kind: 'poll', options: ['Sí', 'No'] } });
  assert.match(poll, /Encuesta.*¿Vienes\?.*Sí.*No/);
  assert.equal((poll.match(/¿Vienes\?/g) || []).length, 1);
  const votable = renderFixtureMessage({ ...base, text: '¿Vienes?', metadata: { kind: 'poll', options: ['Sí', 'No'], results: {
    available: true, totalVoters: 2, options: [{ name: 'Sí', count: 2, selectedByMe: false }],
  } } });
  assert.match(votable, /message-poll-option.*message-poll-count 2.*message-poll-submit Votar/);
  assert.match(renderFixtureMessage({ ...base, metadata: { kind: 'event', description: 'Sala', startTime: 1790154000000 } }), /Evento.*Sala/);
  assert.match(renderFixtureMessage({ ...base, text: 'Respuesta', replyToMessageId: 'provider-id', isEdited: true }), /message-kind-icon.*Mensaje no disponible.*Editado/);
});
