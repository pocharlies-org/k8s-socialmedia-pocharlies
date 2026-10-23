import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FeatureStore,
  featureShortcut,
  hasOpenBlockingDialog,
  attachmentItems,
  canMarkVisibleRead,
  chatIsArchived,
  chatIsFavorite,
  matchesChatView,
  newIncomingMessageIds,
  normalizeFeatureState,
  reconcileServerLists,
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

test('server list snapshots retain legacy local lists and remove only previously synced lists', () => {
  const legacy = { id: 'old', name: 'Antes', chatIds: ['local-chat'] };
  const first = reconcileServerLists({ lists: [legacy] }, { Familia: ['server-chat'] });
  assert.deepEqual(first.lists, [legacy, { id: 'server-Familia', name: 'Familia', chatIds: ['server-chat'] }]);
  assert.deepEqual(first.serverListNames, ['Familia']);
  const renamed = reconcileServerLists(first, { Familia: ['new-chat'], Trabajo: [] });
  assert.deepEqual(renamed.lists, [legacy, { id: 'server-Familia', name: 'Familia', chatIds: ['new-chat'] }, { id: 'server-Trabajo', name: 'Trabajo', chatIds: [] }]);
  const deleted = reconcileServerLists(renamed, { Trabajo: [] });
  assert.deepEqual(deleted.lists, [legacy, { id: 'server-Trabajo', name: 'Trabajo', chatIds: [] }]);
  assert.deepEqual(reconcileServerLists(deleted, []), deleted, 'invalid snapshots must not erase lists');
});

test('privacy snapshots normalize Baileys keys without inventing missing values', () => {
  assert.deepEqual(normalizePrivacySnapshot({ profile: 'contacts', last: 'none', readreceipts: 'all' }), {
    profile: 'contacts',
    lastSeen: 'none',
    status: null,
    readReceipts: 'true',
  });
  assert.deepEqual(normalizePrivacySnapshot({ profile: 'unknown', data: { profile: 'none' } }), {
    profile: 'none',
    lastSeen: null,
    status: null,
    readReceipts: null,
  });
  assert.deepEqual(normalizePrivacySnapshot({}), { profile: null, lastSeen: null, status: null, readReceipts: null });
});

test('status audience preserves an existing exclusion choice and changes only when selected', () => {
  const initial = normalizePrivacySnapshot({ status: 'contact_blacklist' });
  assert.equal(initial.status, 'contact_blacklist');
  assert.deepEqual(privacyChanges(initial, initial), []);
  assert.deepEqual(privacyChanges(initial, { ...initial, status: 'contacts' }), [{ field: 'status', value: 'contacts' }]);
  assert.deepEqual(privacyChanges(initial, { ...initial, status: 'invalid' }), []);
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

test('online and group privacy retain provider values and emit only explicit changes', () => {
  const initial = normalizePrivacySnapshot({ profile: 'contact_blacklist', online: 'match_last_seen', groupadd: 'contact_blacklist' });
  assert.equal(initial.profile, 'contact_blacklist');
  assert.equal(initial.online, 'match_last_seen');
  assert.equal(initial.groupsAdd, 'contact_blacklist');
  assert.deepEqual(privacyChanges(initial, initial), []);
  assert.deepEqual(privacyChanges(initial, { ...initial, online: 'all', groupsAdd: 'contacts' }), [
    { field: 'online', value: 'all' }, { field: 'groupsAdd', value: 'contacts' },
  ]);
  assert.deepEqual(privacyChanges(initial, { online: 'invalid', groupsAdd: 'none' }), []);
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
  assert.equal(canMarkVisibleRead({ account: 'alpha', chat: 'chat', manualUnreadKey: 'alpha:chat' }), false);
  assert.equal(canMarkVisibleRead({ account: 'beta', chat: 'chat', manualUnreadKey: 'alpha:chat' }), true);
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
  assert.equal(visiblePresenceLabel({ state: 'composing', online: true, available: true }), 'Escribiendo…');
  assert.equal(visiblePresenceLabel({ state: 'recording', online: true, available: true }), 'Grabando audio…');
  assert.equal(presenceLabel({ state: 'unavailable', available: true }), 'Desconectado');
  assert.match(presenceLabel({ lastSeen: '2026-09-23T09:00:00Z' }), /Última vez/);
  assert.match(presenceLabel({ status: 'unavailable', lastSeen: 1786000000 }), /Última vez/);
  assert.equal(presenceLabel({ status: 'unavailable', lastSeen: 0 }), 'Desconectado');
  assert.equal(presenceLabel({ status: 'unknown', lastSeen: -1 }), 'Estado no disponible');
  assert.equal(visiblePresenceLabel({ state: 'online', available: false }), '');
  assert.equal(visiblePresenceLabel({ state: 'online', available: true }), 'En línea');
  assert.equal(visiblePresenceLabel({ state: 'unknown', available: true }), '');
  assert.equal(safePhotoUrl('https://cdn.example.test/avatar.jpg', 'https://app.example.test/'), '');
  assert.equal(safePhotoUrl('/api/profile/photo?id=1', 'https://app.example.test/'), 'https://app.example.test/api/profile/photo?id=1');
  assert.equal(safePhotoUrl('javascript:alert(1)', 'https://app.example.test/'), '');
});

test('shortcuts honor exact modifiers and leave typing, dialogs and IME alone', () => {
  const key = (name, modifiers = {}) => ({ key: name, ...modifiers, target: { closest: () => null } });
  const context = { account: 'alpha', chat: 'alpha-direct' };
  assert.equal(featureShortcut(key('F', { ctrlKey: true, shiftKey: true }), context), 'search');
  assert.equal(featureShortcut(key('n', { ctrlKey: true, altKey: true }), { account: 'alpha' }), 'new-chat');
  assert.equal(featureShortcut(key('N', { ctrlKey: true, altKey: true, shiftKey: true }), { account: 'alpha' }), 'new-group');
  for (const [letter, modifiers, expected] of [
    ['i', { altKey: true }, 'info'], ['a', { altKey: true }, 'attach'],
    ['e', { ctrlKey: true, altKey: true }, 'emoji'],
    ['u', { ctrlKey: true, altKey: true, shiftKey: true }, 'unread'],
    ['m', { ctrlKey: true, altKey: true, shiftKey: true }, 'mute'],
    ['e', { ctrlKey: true, altKey: true, shiftKey: true }, 'archive'],
    ['p', { ctrlKey: true, altKey: true, shiftKey: true }, 'pin'],
  ]) assert.equal(featureShortcut(key(letter, modifiers), context), expected);
  assert.equal(featureShortcut(key('i', { altKey: true }), { account: 'alpha' }), '');
  assert.equal(featureShortcut(key('i', { altKey: true }), { ...context, modalOpen: true }), '');
  assert.equal(featureShortcut(key('i', { altKey: true, isComposing: true }), context), '');
  assert.equal(featureShortcut(key('i', { altKey: true, repeat: true }), context), '');
  assert.equal(featureShortcut(key('i', { altKey: true, metaKey: true }), context), '');
  assert.equal(featureShortcut({ ...key('i', { altKey: true }), target: { closest: () => ({ tagName: 'TEXTAREA' }) } }, context), '');
  assert.equal(featureShortcut(key('i', { altKey: true }), { chat: 'alpha-direct' }), '');
});

test('a visible modal dialog blocks shortcuts even when focus remains on a button behind it', () => {
  const behind = { closest: () => null };
  const shortcut = { key: 'e', ctrlKey: true, altKey: true, shiftKey: true, target: behind };
  const context = { account: 'alpha', chat: 'alpha-direct' };
  const hiddenDialog = { closest: selector => selector === '[hidden]' ? { className: 'communities-shade' } : null };
  const openDialog = { closest: () => null };
  const documentRef = { querySelectorAll: () => [hiddenDialog] };
  assert.equal(hasOpenBlockingDialog(documentRef), false);
  assert.equal(featureShortcut(shortcut, { ...context, modalOpen: hasOpenBlockingDialog(documentRef) }), 'archive');
  documentRef.querySelectorAll = () => [openDialog];
  assert.equal(hasOpenBlockingDialog(documentRef), true);
  assert.equal(featureShortcut(shortcut, { ...context, modalOpen: hasOpenBlockingDialog(documentRef) }), '');
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

test('runScopedMutation limpia el banner de error al acertar (QA #13)', async () => {
  const shown = [];
  const result = await runScopedMutation({
    request: async () => ({ ok: true }), isCurrent: () => true,
    success: 'Enviado.', toast: () => {}, showError: message => shown.push(message),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(shown, [''], 'el éxito debe borrar el banner dejado por un fallo anterior');
});

test('en modo selección, pulsar la burbuja alterna el mensaje (QA 22-10)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  // El click en la burbuja debe alternar sin tocar el checkbox, y los elementos
  // interactivos (media, enlaces, checkbox) no pueden desencadenar la selección.
  assert.match(ui, /bubble\.onclick = runtime\.selectedMessageIds\.size/);
  assert.match(ui, /closest\?\.\('button, a, input'\)|closest\('button, a, input'\)/);
  assert.match(ui, /toggleMessageSelected\(id, !runtime\.selectedMessageIds\.has\(id\)\)/);
});

test('«Nuevo grupo» deshabilita «Continuar» hasta nombre + ≥1 miembro (UX #49.1)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /const syncSubmit = \(\) => \{ submit\.disabled = !groupValid\(\); \}/);
  assert.match(ui, /form\.addEventListener\('input', syncSubmit\)/);
  assert.match(ui, /syncSubmit\(\);/);
});

test('la ficha de grupo enseña announce/restrict solo si puedes cambiarlos (UX #49.2)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /if \(bool\(capabilities\.changeSettings\)\)/);
  assert.match(ui, /Solo administradores pueden enviar mensajes/);
  assert.match(ui, /action: 'settings', \[key\]: check\.checked/);
});

test('privacidad sin ningún valor leído no deja guardar a ciegas (UX 20.1)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /loaded = known\.some\(value => value !== '' && value !== null && value !== undefined\)/);
  assert.match(ui, /submit\.disabled = !loaded/);
  assert.match(ui, /No se ha podido leer tu estado actual/);
});

test('filtrando por lista, una pestaña con su nombre queda activa y sale (QA 22-10)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /documentRef\.getElementById\('feature-list-chip'\)\?\.remove\(\)/);
  assert.match(ui, /`Lista: \$\{listView\.name\}`/);
  assert.match(ui, /chip\.setAttribute\('aria-pressed', 'true'\)/);
  assert.match(ui, /chip\.onclick = \(\) => setView\('all'\)/);
});

test('quickChatAction reutiliza chat-actions con refresco de fila (UX 21.2)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /quickChatAction: async \(chat, action\) =>/);
  assert.match(ui, /\['archive', 'pin', 'mute'\]\.includes\(action\)/);
  assert.match(ui, /updateChatFlags\(chat\.id, \{ \[action === 'archive' \? 'archived'/);
});

test('saltar a una cita ilumina el destino con message-highlight (QA 22-10)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /target\.classList\.add\('message-highlight'\)/);
});
test('la rejilla de la galería usa el thumb y pagina con «Cargar más» (QA #72)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /image\.src = item\.thumbUrl \|\| url/);
  assert.match(ui, /\{ chat: runtime\.chat, kind: serverKind, limit: 60 \}/);
  assert.match(ui, /button\(documentRef, 'Cargar más', 'feature-button subtle'\)/);
  assert.match(ui, /kind: serverKind, limit: 60, cursor/);
});
test('silenciar ofrece «Siempre» y el menú de adjuntos ofrece «GIF» (UX #26.1, QA #85)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /\['Siempre', \(\) => perform\('mute', \{ muted: true \}\)\]/);
  assert.match(ui, /addAttach\('GIF', 'gif'/);
  assert.match(ui, /input\.accept = 'image\/gif'/);
  assert.match(ui, /kind: 'gif', name: file\.name, mimeType: 'image\/gif'/);
});
test('QA #80: tras un compose se refresca una vez llegado el eco diferido', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /function refetchAfterEcho\(\)/);
  assert.match(ui, /if \(result\) refetchAfterEcho\(\);/);
  assert.match(ui, /onSent: \(\) => \{closeModal\(\); void loadMessages\(\); refetchAfterEcho\(\);\}/);
  assert.match(ui, /if \(result\) \{ refetchAfterEcho\(\); closeModal\(\); \}/);
});
test('QA #59: el diálogo de acciones del mensaje es un menú navegable con flechas', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /setAttribute\('aria-label', 'Acciones del mensaje'\)/);
  assert.match(ui, /item\.setAttribute\('role', 'menuitem'\); item\.tabIndex = -1; item\.onclick = \(\) => handler\(message\)/);
  assert.match(ui, /actions\.firstElementChild\?\.focus\(\)/);
  assert.match(ui, /event\.key === 'ArrowDown' \? \(index \+ 1\) % items\.length : event\.key === 'ArrowUp'/);
});
test('«Destacados» es una vista con estado vacío, no un diálogo (QA #89/#97)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /async function renderStarredView\(container\)/);
  assert.match(ui, /Aún no has destacado ningún mensaje\. Abre el menú «⋯» de un mensaje y elige «Destacar»\./);
  assert.match(ui, /item\.onclick = \(\) => setView\(view\);/);
  assert.match(ui, /starredView: renderStarredView,/);
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /featureUI\.starredView\?\.\(\$\('chats'\)\)/);
});

test('un miembro con chat abierto es un botón que lo abre (QA #97)', async () => {
  const src = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /const known = member\.id \? array\(getChats\(\)\)\.find\(chat => text\(chat\.id\) === member\.id\) : null/);
  assert.match(src, /node\(known \? 'button' : 'div', 'feature-member'\)/);
  assert.match(src, /row\.onclick = \(\) => \{ closeModal\(\); selectChat\(known\); \}/);
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /button\.feature-member \{ width: 100%; border: 0;/);
});

test('los tres formularios de creación pintan el motivo en vez de callar (QA #107)', async () => {
  const src = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /function formValidator\(documentRef, form\) \{/);
  assert.equal((src.match(/formValidator\(documentRef, form\)/g) || []).length, 4);
  assert.match(src, /showError\('Indica el nombre del grupo y al menos un participante\.'\)/);
  assert.match(src, /name: values\.name\.trim\(\)\.slice\(0, 100\)/);
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.feature-form-error \{ margin: 0; color: var\(--danger\);/);
});

test('el aviso de bloqueados cuenta lo filtrado y la ficha no pinta el LID (QA #105, UX #32.1)', async () => {
  const src = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /coinciden con la búsqueda\./);
  assert.match(src, /Ningún contacto bloqueado coincide con esta búsqueda\./);
  assert.doesNotMatch(src, /node\('small', '', member\.id \|\| 'Identidad no disponible'\)/);
  assert.match(src, /if \(!memberName && member\.id\) copy\.append\(node\('small', '', member\.id\)\)/);
});

test('la galería usa <a href> reales y el panel de listas se llama «Listas» (QA #115.1, UX #33)', async () => {
  const src = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /const card = url \? node\('a', 'feature-gallery-card'\)/);
  assert.match(src, /card\.href = url; card\.target = '_blank'; card\.rel = 'noopener noreferrer';/);
  assert.doesNotMatch(src, /card\.setAttribute\('role', 'link'\)/);
  assert.match(src, /openModal\('Listas'/);
  assert.match(src, /'Las listas se guardan en esta cuenta \(SocialMedia\)\.'/);
  assert.doesNotMatch(src, /Actualizar listas/);
});

test('la galería avisa y ofrece reintentar cuando el servidor falla (QA #114)', async () => {
  const src = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /loadError = err;/);
  assert.match(src, /'Reintentar', 'feature-button subtle'\)/);
  assert.doesNotMatch(src, /items = localGallery\(kind\)/);
});

test('el clic derecho en una burbuja abre el menú del mensaje (QA #59 addendum)', async () => {
  const src = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /bubble\.oncontextmenu = event => \{ event\.preventDefault\(\); openMessageActions\(message, event\); \};/);
});

test('reenviar al chat abierto refresca el transcript (QA #116)', async () => {
  const src = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(sent && targets\.includes\(source\.chat\)\) refetchAfterEcho\(\);/);
});

test('los mensajes ajenos ofrecen «Eliminar para mí» con el alcance único (UX #36.1)', async () => {
  const src = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /add\('Eliminar para mí', item => \{ closeModal\(\); openDelete\(item, false\); \}/);
  assert.match(src, /function openDelete\(message, mine = true\)/);
  assert.match(src, /\.\.\.\(mine \? \[option\(documentRef, 'Eliminar para todos', 'everyone'\)\] : \[\]\)/);
});

test('los seis filtros del listado llevan recuento y aria-label con número (QA #84)', async () => {
  const src = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /counts\[view\] = filterChats\.filter\(chat => matchesChatView\(chat, view, local\)\)\.length/);
  assert.match(src, /item\.setAttribute\('aria-label', `\$\{label\}: \$\{counts\[view\]\}`\)/);
  assert.match(src, /entry\.setAttribute\('aria-label', `Archivados: \$\{counts\.archived\}`\)/);
  assert.match(src, /filterChats = array\(chats\);\n\s*updateFilterCounts\(\);/);
});
test('el adjunto citado se nombra por tipo (nit QA 22-10)', async () => {
  const src = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /type\.startsWith\('video'\) \? 'Vídeo'/);
  assert.match(src, /type === 'sticker' \? 'Pegatina'/);
  assert.match(src, /startsWith\('image'\) \? 'Foto'/);
});
test('los campos de teléfono piden pad numérico y enseñan el formato (UX #42.3/#43.1)', async () => {
  const src = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(placeholder\) input\.placeholder = placeholder;/);
  assert.match(src, /'Número o identificador', 'tel', 'address', '', '\+34 600 000 000'/);
  assert.match(src, /'Número o identificador', 'tel', 'memberId', '', '\+34 600 000 000'/);
  assert.match(src, /'members', '', '\+34600112233, \+34600112244'/);
  assert.doesNotMatch(src, /'Número o identificador', 'text'/);
});
test('la encuesta enseña el contador del tope al acercarse (UX #44.2)', async () => {
  const src = await readFile(new URL('../public/poll-composer.mjs', import.meta.url), 'utf8');
  assert.match(src, /span\.hidden = input\.value\.length < max - 25/);
  assert.match(src, /counter\(question, 255\)/);
  assert.match(src, /counter: counter\(input, 100\)/);
  assert.match(src, /row\.label\.append\(row\.input, row\.counter\)/);
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.poll-count \{ display:block; text-align:right;/);
});

test('la pegatina es la palabra en toda la interfaz (UX #46.2)', async () => {
  const {readFile} = await import('node:fs/promises');
  const src = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /addTab\('Crear pegatina'/);
  assert.match(src, /addAttach\('Nueva pegatina'/);
  assert.match(src, /'Enviar pegatina'/);
  assert.doesNotMatch(src, /'Crear sticker'|'Nuevo sticker'|'Enviar sticker'|Emoji, GIF y stickers/);
});

test('el badge de no leídos pasa AA: blanco sobre el verde (UX #51.1)', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const badge = css.match(/\.chat-item > \.badge \{[^}]*\}/)[0];
  assert.match(badge, /background: var\(--accent\)/);
  assert.match(badge, /color: #fff/);
  assert.doesNotMatch(badge, /color: #07170f/);
});

test('«Reaccionar» abre fila rápida de 6 y el picker solo tras «+» (UX #55.1)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /const QUICK_REACTIONS = \['👍', '❤️', '😂', '😮', '😢', '🙏'\]/);
  assert.match(ui, /button\.onclick = \(\) => reactTo\(message, emoji\)/);
  assert.match(ui, /more\.onclick = showFullPicker/);
  assert.match(ui, /modal\.body\.append\(row\)/);
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.feature-quick-reactions button \{[^}]*min-height: 44px/);
});

test('subtítulo de cabecera y paleta de emisor pasan AA (UX #52)', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const subtitle = css.match(/#chat-subtitle \{[^}]*\}/)[0];
  assert.match(subtitle, /color: var\(--muted-strong\)/);
  assert.doesNotMatch(subtitle, /color: var\(--muted\)/);
  // Los claros (tema claro, sobre burbuja blanca) cumplen AA; los oscuros van en :root.
  for (const color of ['#b02a78', '#2f5fd0', '#b25e1f', '#7c3aed', '#0b6ba8', '#c92f2f', '#1f7a33', '#a35a05']) {
    assert.match(css, new RegExp(`body\\[data-theme="light"\\] \\.sender-palette-\\d \\{ color: ${color}; \\}`));
  }
  assert.match(css, /\.sender-palette-0 \{ color: #f06ab8; \}/);
});

test('ficha de contacto: sin nombre útil pinta «Grupo»/«Contacto», nunca el jid (UX #32.1)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /const title = info\.name \|\| profile\.name \|\| \(isGroup \? 'Grupo' : 'Contacto'\);/);
  assert.doesNotMatch(ui, /node\('h3', '', info\.name \|\| profile\.name \|\| runtime\.chat\)/);
});

test('reenviar: buscador + hasta 5 destinos con contador, sin <select> de 1034 (UX #57 / QA #92)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /select\.name = 'targetChat'/);
  assert.match(ui, /search\.setAttribute\('aria-label', 'Buscar conversación de destino'\)/);
  assert.match(ui, /chosen\.size >= 5/);
  assert.match(ui, /`Reenviar a \$\{chosen\.size\}`/);
  assert.match(ui, /'Contacto sin nombre'/);
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.feature-forward-row \{[^}]*min-height: 44px/);
});

test('menú ⋮ de cabecera: role=menu con flechas, Bloquear compartido y Privacidad en Ajustes (UX #60)', async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  // El menú de cabecera es un menú, no un diálogo de botones sueltos.
  assert.match(ui, /modal\.dialog\.setAttribute\('role', 'menu'\)/);
  assert.match(ui, /item\.setAttribute\('role', 'menuitem'\); item\.tabIndex = -1;/);
  assert.match(ui, /keyEvent\.key === 'ArrowDown' \? \(index \+ 1\) % items\.length/);
  // Bloquear: una sola confirmación compartida, llamada desde fila y cabecera.
  assert.match(ui, /function confirmBlockToggle\(account, chat, blocked\) \{/);
  assert.equal((ui.match(/=> confirmBlockToggle\(account/g) || []).length, 2);
  assert.match(ui, /add\(blocked \? 'Desbloquear' : 'Bloquear', \(\) => confirmBlockToggle\(account, blockChat, blocked\)\)/);
  // Ajustes tiene la entrada de Privacidad global, con el mismo modal.
  assert.match(html, /id="settings-privacy"/);
  assert.match(ui, /getElementById\('settings-privacy'\)\?\.addEventListener\('click'/);
});

test('el diálogo abierto desde otro devuelve el foco al disparador (UX #71)' , async () => {
  const ui = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  // El opener desprendido por closeModal se reencadena al que acaba de recuperar el foco.
  assert.match(ui, /if \(opener\?\.isConnected === false\) opener = documentRef\.activeElement;/);
  assert.match(ui, /if \(modal\.opener\?\.isConnected !== false\) modal\.opener\.focus\?\.\(\)/);
});
