'use strict';

/*
 * Feature UI for the selected WhatsApp Web inventory.  The module owns the
 * feature menus and dialogs while app.js remains responsible for transport,
 * account isolation, message polling, and the existing AI flow.
 */

export const FEATURE_CONTRACT = Object.freeze({
  chatInfo: { method: 'GET', path: '/api/chat-details', response: 'name, contact|group, participants, presence, avatarUrl' },
  chatMedia: { method: 'GET', path: '/api/chats/media', response: 'items[] with kind, url, name, timestamp, nextCursor' },
  search: { method: 'GET', path: '/api/search', response: 'results[] with chatId, chatName, messageId, text, timestamp' },
  messageAround: { method: 'GET', path: '/api/messages/around', response: 'messages[] with targetMessageId' },
  chatRead: { method: 'POST', path: '/api/chat-actions', body: 'account, chat, action=read|unread' },
  chatAction: { method: 'POST', path: '/api/chat-actions', body: 'account, chat, action=archive|unarchive|pin|unpin|mute|unmute|favorite|unfavorite' },
  messageReaction: { method: 'POST', path: '/api/messages/react', body: 'account, chat, messageId, emoji' },
  messageForward: { method: 'POST', path: '/api/messages/forward', body: 'account, chat, messageId, targetChat (one request per selected message)' },
  messageEdit: { method: 'POST', path: '/api/messages/edit', body: 'account, chat, messageId, text' },
  messageDelete: { method: 'POST', path: '/api/messages/delete', body: 'account, chat, messageId, scope' },
  messageStar: { method: 'POST', path: '/api/chat-actions', body: 'account, chat, action=starred|unstarred, messageId' },
  chatStart: { method: 'POST', path: '/api/chats/new', body: 'account, phone', response: 'chat{id,name,phone}, confirmed' },
  contactCreate: { method: 'POST', path: '/api/contacts', body: 'account, phone, displayName' },
  groupCreate: { method: 'POST', path: '/api/groups', body: 'account, name, participants[]' },
  groupMember: { method: 'POST', path: '/api/groups/action', body: 'account, chat, action=add|remove|promote|demote, participant' },
  list: { method: 'GET/POST', path: '/api/lists', response: 'GET lists[]; POST accepts action=list, list, chat|id' },
  starred: { method: 'GET', path: '/api/favorites/starred', response: 'items[] with id, messageId, chatId, text, timestamp' },
  share: { method: 'POST', path: '/api/messages/compose', body: 'account, chat, kind=contact|poll|event, payload' },
  chatPrivacy: { method: 'POST', path: '/api/privacy', body: 'account, chat, disappearingSeconds?' },
  privacy: { method: 'GET/POST', path: '/api/privacy', body: 'account, profile?, lastSeen?, readReceipts?' },
});

const STORAGE_PREFIX = 'socialmedia-wa-features:';
const LOCAL_EMOJIS = ['😀', '😂', '🥹', '😊', '😍', '😎', '🤝', '👏', '🙌', '❤️', '🔥', '👍', '👎', '🎉', '✅', '🙏', '💡', '👀', '😅', '🤔', '😭', '😡', '💚', '✨'];
const MESSAGE_URL_RE = /https?:\/\/[^\s<]+/gi;

function text(value) {
  return value == null ? '' : String(value);
}

function bool(value) {
  return value === true || value === 'true' || value === 1;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(value) {
  return [...new Set(array(value).map(item => text(item).trim()).filter(Boolean))];
}

export function normalizeFeatureState(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    archivedChats: uniqueStrings(source.archivedChats),
    pinnedChats: uniqueStrings(source.pinnedChats),
    mutedChats: uniqueStrings(source.mutedChats),
    favoriteChats: uniqueStrings(source.favoriteChats),
    starredMessages: uniqueStrings(source.starredMessages),
    lists: array(source.lists).filter(item => item && typeof item === 'object').map(item => ({
      id: text(item.id).trim(),
      name: text(item.name).trim(),
      chatIds: uniqueStrings(item.chatIds || item.chats),
    })).filter(item => item.id && item.name),
    view: ['all', 'unread', 'groups', 'archived', 'favorites', 'starred'].includes(source.view) || array(source.lists).some(list => `list:${list?.id}` === source.view) ? source.view : 'all',
  };
}

export function chatIsArchived(chat, localState = {}) {
  if (hasProviderFlag(chat, ['archived', 'isArchived', 'archivedAt'])) return bool(chat?.archived) || bool(chat?.isArchived) || Boolean(chat?.archivedAt);
  return uniqueStrings(localState.archivedChats).includes(text(chat?.id));
}

export function chatIsPinned(chat, localState = {}) {
  if (hasProviderFlag(chat, ['pinned', 'isPinned'])) return bool(chat?.pinned) || bool(chat?.isPinned);
  return uniqueStrings(localState.pinnedChats).includes(text(chat?.id));
}

export function chatIsMuted(chat, localState = {}) {
  if (hasProviderFlag(chat, ['muted', 'isMuted'])) return bool(chat?.muted) || bool(chat?.isMuted);
  return uniqueStrings(localState.mutedChats).includes(text(chat?.id));
}

export function chatIsFavorite(chat, localState = {}) {
  if (hasProviderFlag(chat, ['favorite', 'isFavorite'])) return bool(chat?.favorite) || bool(chat?.isFavorite);
  return uniqueStrings(localState.favoriteChats).includes(text(chat?.id));
}

function hasProviderFlag(chat, keys) {
  return Boolean(chat && typeof chat === 'object' && keys.some(key => Object.prototype.hasOwnProperty.call(chat, key)));
}

/** Archived chats are intentionally omitted from Todos. */
export function matchesChatView(chat, view = 'all', localState = {}) {
  const archived = chatIsArchived(chat, localState);
  if (view === 'archived') return archived;
  if (archived) return false;
  if (view === 'unread') return Number(chat?.unread) > 0 || bool(chat?.unread);
  if (view === 'groups') return bool(chat?.isGroup);
  if (view === 'favorites') return chatIsFavorite(chat, localState);
  if (view.startsWith('list:')) return Boolean(findList(localState, view.slice(5))?.chatIds.includes(text(chat?.id)));
  return true;
}

export function findList(localState, listId) {
  return normalizeFeatureState(localState).lists.find(list => list.id === text(listId)) || null;
}

export function presenceLabel(value, locale = 'es-ES', now = new Date()) {
  const source = value && typeof value === 'object' ? value : {};
  const presence = text(source.presence || source.status || source.state).toLowerCase();
  if (source.online === true || ['online', 'available', 'composing', 'recording', 'paused'].includes(presence)) return 'En línea';
  const lastSeen = source.lastSeen || source.last_seen || source.lastSeenAt;
  const date = lastSeen == null ? null : new Date(typeof lastSeen === 'number' && lastSeen < 1e12 ? lastSeen * 1000 : lastSeen);
  if (date && !Number.isNaN(date.getTime())) {
    return `Última vez ${new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(date)}`;
  }
  if (source.online === false || ['offline', 'unavailable'].includes(presence)) return 'Desconectado';
  return 'Estado no disponible';
}

export function visiblePresenceLabel(value, locale = 'es-ES', now = new Date()) {
  if (!value || value.available !== true) return '';
  const label = presenceLabel(value, locale, now);
  return label === 'Estado no disponible' ? '' : label;
}

/** Only authenticated, same-origin app media paths are accepted for photos. */
export function safePhotoUrl(value, baseUrl = 'http://localhost/') {
  const candidate = text(value).trim();
  if (!candidate) return '';
  try {
    const base = new URL(baseUrl, 'http://localhost/');
    const url = new URL(candidate, base);
    if (url.origin !== base.origin || !url.pathname.startsWith('/api/')) return '';
    return url.href;
  } catch {
    return '';
  }
}

export function safeWebUrl(value, baseUrl = 'http://localhost/') {
  const candidate = text(value).trim().replace(/[),.!?;:]+$/, '');
  if (!candidate) return '';
  try {
    const url = new URL(candidate, baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export function canMarkVisibleRead({ hidden = false, visibilityState = 'visible', account = '', chat = '', lastMarked = '' } = {}) {
  return Boolean(account && chat && !hidden && visibilityState === 'visible' && `${account}:${chat}` !== lastMarked);
}

/** Return only incoming messages observed after the per-chat notification baseline. */
export function newIncomingMessageIds(previousIds = [], messages = []) {
  const previous = new Set(uniqueStrings(previousIds));
  return array(messages).filter(message => message?.fromMe !== true && text(message?.id) && !previous.has(text(message.id))).map(message => text(message.id));
}

export function shouldNotifyChatUpdate(previous, next, { hidden = false, permission = 'default', muted = false } = {}) {
  if (!previous || !next || !hidden || permission !== 'granted' || muted) return false;
  const previousDate = new Date(typeof previous.timestamp === 'number' && previous.timestamp < 1e12 ? previous.timestamp * 1000 : previous.timestamp || '');
  const nextDateValue = new Date(typeof next.timestamp === 'number' && next.timestamp < 1e12 ? next.timestamp * 1000 : next.timestamp || '');
  const newer = !Number.isNaN(previousDate.getTime()) && !Number.isNaN(nextDateValue.getTime())
    ? nextDateValue > previousDate
    : text(previous.timestamp) !== text(next.timestamp);
  return newer && Number(next.unread) > Number(previous.unread);
}

function privacyVisibility(value) {
  const normalized = text(value).trim().toLowerCase();
  return ['all', 'contacts', 'none'].includes(normalized) ? normalized : null;
}

function privacyReceipts(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const normalized = text(value).trim().toLowerCase();
  if (['all', 'true', 'enabled', 'on'].includes(normalized)) return 'true';
  if (['none', 'false', 'disabled', 'off'].includes(normalized)) return 'false';
  return null;
}

/** Normalize provider privacy keys without inventing values for missing fields. */
export function normalizePrivacySnapshot(value = {}) {
  const root = value && typeof value === 'object' ? value : {};
  const source = root.privacy && typeof root.privacy === 'object'
    ? root.privacy
    : root.data && typeof root.data === 'object'
      ? root.data
      : root;
  return {
    profile: privacyVisibility(source.profile ?? source.profilePicture ?? source.profile_picture),
    lastSeen: privacyVisibility(source.lastSeen ?? source.last_seen ?? source.last),
    readReceipts: privacyReceipts(source.readReceipts ?? source.read_receipts ?? source.readreceipts),
  };
}

/** Return only explicit changes, using connector privacy field names and values. */
export function privacyChanges(initial = {}, current = {}) {
  const before = normalizePrivacySnapshot(initial);
  const after = normalizePrivacySnapshot(current);
  const changes = [];
  if (after.profile && after.profile !== before.profile) changes.push({ field: 'profilePicture', value: after.profile });
  if (after.lastSeen && after.lastSeen !== before.lastSeen) changes.push({ field: 'lastSeen', value: after.lastSeen });
  if (after.readReceipts && after.readReceipts !== before.readReceipts) changes.push({ field: 'readReceipts', value: after.readReceipts === 'true' ? 'all' : 'none' });
  return changes;
}

export async function runScopedMutation({ request, isCurrent, refreshChats, refreshMessages, success, toast, showError }) {
  try {
    const result = await request();
    if (!isCurrent()) return null;
    if (refreshChats) await refreshChats();
    if (!isCurrent()) return null;
    if (refreshMessages) await refreshMessages();
    if (!isCurrent()) return null;
    if (success) toast(success, 'success');
    return result;
  } catch (error) {
    if (!isCurrent()) return null;
    toast(error.message || 'No se pudo completar la acción.', 'error');
    showError(error.message || 'No se pudo completar la acción.');
    return null;
  }
}

export function extractLinks(messages = []) {
  const links = [];
  for (const message of array(messages)) {
    for (const candidate of text(message?.text || message?.content).match(MESSAGE_URL_RE) || []) {
      const url = safeWebUrl(candidate);
      if (url) links.push({ url, name: url, messageId: message?.id, timestamp: message?.timestamp, kind: 'link' });
    }
  }
  return links;
}

export function attachmentItems(messages = [], kind = 'media') {
  const result = [];
  for (const message of array(messages)) {
    for (const attachment of array(message?.attachments)) {
      const mime = text(attachment?.mimeType || attachment?.mime_type).toLowerCase();
      const type = text(attachment?.type).toLowerCase();
      const media = mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') || ['image', 'photo', 'video', 'audio', 'sticker'].includes(type);
      const document = !media;
      if ((kind === 'media' && !media) || (kind === 'documents' && !document)) continue;
      result.push({
        ...attachment,
        url: attachment.url || attachment.fileUrl || attachment.file_url,
        name: attachment.name || attachment.fileName || attachment.file_name || 'Archivo adjunto',
        messageId: message?.id,
        timestamp: message?.timestamp,
        kind: media ? 'media' : 'documents',
      });
    }
  }
  return result;
}

class FeatureStore {
  constructor(storage = null) {
    this.storage = storage;
    this.cache = new Map();
  }

  key(account) { return `${STORAGE_PREFIX}${encodeURIComponent(text(account))}`; }

  read(account) {
    const id = text(account);
    if (this.cache.has(id)) return this.cache.get(id);
    let value = {};
    try { value = JSON.parse(this.storage?.getItem(this.key(id)) || '{}'); } catch { value = {}; }
    const normalized = normalizeFeatureState(value);
    this.cache.set(id, normalized);
    return normalized;
  }

  write(account, value) {
    const normalized = normalizeFeatureState(value);
    this.cache.set(text(account), normalized);
    try { this.storage?.setItem(this.key(account), JSON.stringify(normalized)); } catch { /* Storage may be disabled. */ }
    return normalized;
  }

  update(account, updater) {
    const current = this.read(account);
    const next = typeof updater === 'function' ? updater(structuredCloneSafe(current)) : { ...current, ...updater };
    return this.write(account, next);
  }
}

function structuredCloneSafe(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function makeElement(documentRef, tag, className = '', value) {
  const element = documentRef.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = text(value);
  return element;
}

function button(documentRef, label, className = 'feature-button') {
  const element = makeElement(documentRef, 'button', className, label);
  element.type = 'button';
  return element;
}

function field(documentRef, label, type = 'text', name = '', value = '') {
  const wrapper = makeElement(documentRef, 'label', 'feature-field');
  wrapper.append(makeElement(documentRef, 'span', '', label));
  const input = makeElement(documentRef, type === 'textarea' ? 'textarea' : 'input', '', type === 'textarea' ? undefined : '');
  input.name = name;
  input.value = value;
  if (type !== 'textarea') input.type = type;
  if (type === 'textarea') input.rows = 3;
  wrapper.append(input);
  return { wrapper, input };
}

function option(documentRef, label, value) {
  const item = makeElement(documentRef, 'option', '', label);
  item.value = value;
  return item;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function initials(value) {
  const parts = text(value).trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || 'S').toUpperCase();
}

function messageText(message) {
  return text(message?.text || message?.content).trim() || (array(message?.attachments).length ? 'Archivo adjunto' : 'Mensaje no disponible');
}

function mediaUrl(item, baseUrl = 'http://localhost/') {
  const value = text(item?.url || item?.fileUrl || item?.file_url);
  try {
    const url = new URL(value, baseUrl);
    return url.origin === new URL(baseUrl, 'http://localhost/').origin && url.pathname.startsWith('/api/') ? url.href : '';
  } catch {
    return '';
  }
}

/** Install selected feature controls and return a small bridge for app.js. */
export function installFeatureUI({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  state,
  api,
  query,
  renderChats = () => {},
  loadChats = async () => {},
  loadMessages = async () => {},
  showHistoricalMessage = async () => false,
  selectChat = () => {},
  getMessages = () => [],
  getChats = () => [],
  setChat = () => {},
  showError = () => {},
} = {}) {
  if (!documentRef || !state || typeof api !== 'function' || typeof query !== 'function') return null;

  const store = new FeatureStore(windowRef?.localStorage || globalThis.localStorage);
  const runtime = {
    account: text(state.account),
    chat: text(state.chat),
    selectedChat: state.selectedChat,
    currentMessages: [],
    currentMessageIds: new Set(),
    selectedMessageIds: new Set(),
    replyTarget: null,
    currentView: store.read(state.account).view,
    readPending: new Set(),
    generation: 0,
    lastFocus: null,
    chatListBaseline: new Map(),
    notificationPermission: windowRef?.Notification?.permission || 'default',
    modal: null,
    composeFile: null,
    presenceTimer: null,
    presencePending: new Set(),
  };

  const root = documentRef.body;
  const node = (tag, className = '', value) => makeElement(documentRef, tag, className, value);

  function prefs() { return store.read(runtime.account); }

  function savePrefs(updater) {
    const next = store.update(runtime.account, updater);
    runtime.currentView = next.view;
    return next;
  }

  function toast(message, kind = 'info') {
    let element = documentRef.getElementById('feature-toast');
    if (!element) { element = node('div', 'feature-toast'); element.id = 'feature-toast'; root.append(element); }
    element.className = `feature-toast ${kind}`;
    element.textContent = text(message);
    element.hidden = false;
    clearTimeout(element._timer);
    element._timer = setTimeout(() => { element.hidden = true; }, 3600);
  }

  function closeModal() {
    const modal = runtime.modal;
    if (!modal) return;
    documentRef.removeEventListener?.('keydown', modal.onKey);
    documentRef.removeEventListener?.('pointerdown', modal.onOutside);
    modal.overlay.remove();
    runtime.modal = null;
    if (modal.opener?.isConnected !== false) modal.opener.focus?.();
  }

  function openModal(title, { wide = false, opener = documentRef.activeElement, variant = '' } = {}) {
    closeModal();
    const overlay = node('div', `feature-modal ${wide ? 'feature-modal-wide' : ''} ${variant ? `feature-modal-${variant}` : ''}`);
    overlay.setAttribute('role', 'presentation');
    const dialog = node('section', 'feature-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', String(!variant));
    dialog.setAttribute('aria-labelledby', 'feature-dialog-title');
    const header = node('header', 'feature-dialog-header');
    const heading = node('h2', '', title);
    heading.id = 'feature-dialog-title';
    const close = button(documentRef, 'Cerrar', 'feature-dialog-close');
    close.setAttribute('aria-label', 'Cerrar');
    header.append(heading, close);
    const body = node('div', 'feature-dialog-body');
    dialog.append(header, body);
    overlay.append(dialog);
    root.append(overlay);
    if (variant === 'menu') {
      const bounds = opener?.getBoundingClientRect?.();
      if (bounds) {
        dialog.style.setProperty('--menu-left', `${Math.max(12, Math.min(bounds.left, (windowRef?.innerWidth || 1200) - 270))}px`);
        dialog.style.setProperty('--menu-top', `${Math.max(12, Math.min(bounds.bottom + 4, (windowRef?.innerHeight || 800) - 410))}px`);
      }
    }
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
      if (variant) return;
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button, input, textarea, select, a, [tabindex]:not([tabindex="-1"])')].filter(item => !item.disabled && !item.hidden);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && documentRef.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && documentRef.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    close.onclick = closeModal;
    overlay.onclick = event => { if (event.target === overlay) closeModal(); };
    const onOutside = event => { if (!dialog.contains(event.target) && event.target !== opener) closeModal(); };
    documentRef.addEventListener?.('keydown', onKey);
    if (variant) documentRef.addEventListener?.('pointerdown', onOutside);
    runtime.modal = { overlay, dialog, body, close, opener, onKey, onOutside };
    queueMicrotask(() => body.querySelector('input, textarea, select, button')?.focus?.());
    return { overlay, dialog, body, close };
  }

  function setView(view) {
    runtime.currentView = ['all', 'unread', 'groups', 'archived', 'favorites', 'starred'].includes(view) || (text(view).startsWith('list:') && findList(prefs(), text(view).slice(5))) ? view : 'all';
    state.chatFilter = runtime.currentView;
    savePrefs(current => ({ ...current, view: runtime.currentView }));
    for (const item of documentRef.querySelectorAll('[data-feature-view]')) item.setAttribute('aria-pressed', String(item.dataset.featureView === runtime.currentView));
    updateArchiveView();
    void loadChats();
    renderChats();
  }

  function updateArchiveView() {
    const archived = runtime.currentView === 'archived';
    const sidebar = documentRef.querySelector('.chat-sidebar');
    if (sidebar) sidebar.dataset.archiveView = String(archived);
    const entry = documentRef.getElementById('feature-archived-entry');
    if (entry) entry.setAttribute('aria-pressed', String(archived));
    const heading = documentRef.getElementById('feature-archived-title');
    if (heading) heading.hidden = !archived;
    const hint = documentRef.getElementById('feature-archived-hint');
    if (hint) hint.hidden = !archived;
  }

  function matchesChat(chat, view = runtime.currentView) {
    if (view === 'starred') return false;
    return matchesChatView(chat, view, prefs());
  }

  async function request(path, payload, extra = {}, { includeChat = true } = {}) {
    const isPost = payload !== undefined;
    const body = isPost ? { account: runtime.account, ...(includeChat && runtime.chat ? { chat: runtime.chat } : {}), ...payload } : undefined;
    const result = await api(isPost ? path : query(path, extra), body);
    if (result?.error) throw new Error(typeof result.error === 'string' ? result.error : result.error.message || 'La acción no está disponible.');
    return result || {};
  }

  async function mutate(path, payload, { refreshChats = false, refreshMessages = false, success = '', includeChat = true } = {}) {
    const context = { account: runtime.account, chat: runtime.chat, generation: runtime.generation };
    const current = () => runtime.account === context.account && runtime.chat === context.chat && runtime.generation === context.generation;
    return runScopedMutation({
      request: () => request(path, payload, {}, { includeChat }), isCurrent: current,
      refreshChats: refreshChats ? loadChats : null, refreshMessages: refreshMessages ? loadMessages : null,
      success, toast, showError,
    });
  }

  function updateChatFlags(chatId, values) {
    const chat = array(getChats()).find(item => text(item?.id) === text(chatId));
    if (chat) Object.assign(chat, values);
    for (const [fieldName, localName] of [['archived', 'archivedChats'], ['pinned', 'pinnedChats'], ['muted', 'mutedChats'], ['favorite', 'favoriteChats']]) {
      if (!(fieldName in values)) continue;
      const value = bool(values[fieldName]);
      savePrefs(current => {
        const ids = new Set(current[localName]);
        if (value) ids.add(text(chatId)); else ids.delete(text(chatId));
        return { ...current, [localName]: [...ids] };
      });
    }
    renderChats();
  }

  function initialsAvatar(parent, value, photo) {
    parent.replaceChildren();
    parent.textContent = initials(value);
    const url = safePhotoUrl(photo, windowRef?.location?.href || 'http://localhost/');
    if (!url) return;
    const image = node('img', 'feature-profile-image');
    image.src = url;
    image.alt = '';
    image.loading = 'lazy';
    image.onerror = () => { image.remove(); parent.textContent = initials(value); };
    parent.replaceChildren(image);
  }

  function addSection(parent, title) {
    const heading = node('h3', 'feature-section-title', title);
    parent.append(heading);
    return heading;
  }

  function renderMember(member, info, parent) {
    const row = node('div', 'feature-member');
    const avatar = node('span', 'feature-member-avatar');
    initialsAvatar(avatar, member.name || member.pushName || member.id, member.photoUrl || member.photo_url || member.avatarUrl);
    const copy = node('span', 'feature-member-copy');
    copy.append(node('strong', '', member.name || member.pushName || member.id || 'Contacto'), node('small', '', member.id || 'Identidad no disponible'));
    if (bool(member.isAdmin) || bool(member.admin) || text(member.role).toLowerCase() === 'admin') copy.append(node('em', 'feature-admin', 'Administrador'));
    row.append(avatar, copy);
    const capabilities = info?.capabilities || {};
    if (bool(capabilities.manageMembers) && member.id) {
      const actions = node('span', 'feature-member-actions');
      const isAdmin = bool(member.isAdmin) || bool(member.admin) || text(member.role).toLowerCase() === 'admin';
      const promote = button(documentRef, isAdmin ? 'Quitar admin' : 'Promover', 'feature-button subtle');
      promote.onclick = async () => {
        const result = await mutate('/api/groups/action', { action: isAdmin ? 'demote' : 'promote', participant: member.id }, { refreshMessages: false, success: isAdmin ? 'Administrador actualizado.' : 'Administrador añadido.' });
        if (result) { closeModal(); openInfo(); }
      };
      const remove = button(documentRef, 'Quitar', 'feature-button subtle');
      remove.onclick = async () => {
        if (!windowRef?.confirm?.(`¿Quitar a ${member.name || member.id} del grupo?`)) return;
        const result = await mutate('/api/groups/action', { action: 'remove', participant: member.id }, { refreshMessages: false, success: 'Miembro quitado.' });
        if (result) { closeModal(); openInfo(); }
      };
      actions.append(promote, remove);
      row.append(actions);
    }
    parent.append(row);
  }

  async function openInfo() {
    if (!runtime.chat) return;
    const modal = openModal(runtime.selectedChat?.isGroup ? 'Información del grupo' : 'Información del contacto', { variant: 'panel' });
    modal.body.append(node('p', 'feature-loading', 'Cargando información…'));
    let result;
    try { result = await request('/api/chat-details', undefined, { chat: runtime.chat }); }
    catch (error) { modal.body.replaceChildren(node('p', 'feature-muted', error.message || 'No hay información disponible.')); return; }
    if (!runtime.modal || runtime.modal.body !== modal.body) return;
    const isGroup = result.isGroup === true || runtime.selectedChat?.isGroup === true;
    let presence = result.presence || {};
    if (!isGroup && presence.available !== true) {
      try { presence = await request('/api/presence', undefined, { chat: runtime.chat }); } catch { /* Unknown provider presence stays unknown. */ }
    }
    const info = { ...(runtime.selectedChat || {}), ...result, ...(result.group || {}) };
    const profile = result.contact || result.profile || info;
    const members = array(result.participants || result.members);
    modal.body.replaceChildren();
    const identity = node('div', 'feature-profile-head');
    const photo = node('span', 'feature-profile-photo');
    initialsAvatar(photo, info.name || profile.name || runtime.chat, profile.avatarUrl || profile.avatar_url || info.avatarUrl || info.avatar_url);
    const copy = node('div', 'feature-profile-copy');
    copy.append(node('h3', '', info.name || profile.name || runtime.chat), node('p', 'feature-muted', isGroup ? 'Grupo' : visiblePresenceLabel(presence, 'es-ES')));
    identity.append(photo, copy);
    modal.body.append(identity);
    if (isGroup) {
      if (info.description || info.desc) modal.body.append(node('p', 'feature-description', info.description || info.desc));
      addSection(modal.body, `Miembros${members.length ? ` · ${members.length}` : ''}`);
      if (!members.length) modal.body.append(node('p', 'feature-muted', 'No hay miembros disponibles para esta cuenta.'));
      else for (const member of members) renderMember(member, { ...info, capabilities: result.capabilities || info.capabilities }, modal.body);
      const capabilities = result.capabilities || info.capabilities || {};
      if (bool(capabilities.manageMembers)) {
        const addMember = button(documentRef, 'Añadir miembro', 'feature-button primary');
        addMember.onclick = () => openMemberForm();
        modal.body.append(addMember);
      }
    } else {
      addSection(modal.body, 'Estado');
      const presenceText = visiblePresenceLabel(presence, 'es-ES');
      if (presenceText) modal.body.append(node('p', 'feature-presence', presenceText));
      if (profile.about) modal.body.append(node('p', 'feature-description', profile.about));
    }
    const gallery = node('div', 'feature-gallery-actions');
    for (const [label, kind] of [['Fotos y vídeos', 'media'], ['Enlaces', 'links'], ['Documentos', 'documents']]) {
      const action = button(documentRef, label, 'feature-button subtle');
      action.onclick = () => openGallery(kind);
      gallery.append(action);
    }
    modal.body.append(gallery);
    const privacy = node('div', 'feature-inline-settings');
    addSection(privacy, 'Mensajes temporales');
    const select = documentRef.createElement('select');
    select.setAttribute('aria-label', 'Duración de mensajes temporales');
    select.append(option(documentRef, 'Desactivados', '0'), option(documentRef, '24 horas', '86400'), option(documentRef, '7 días', '604800'), option(documentRef, '90 días', '7776000'));
    select.value = String(info.disappearingSeconds || info.disappearing_seconds || 0);
    select.onchange = async () => {
      const result = await mutate('/api/privacy', { disappearingSeconds: Number(select.value) }, { success: 'Preferencia actualizada.' });
      if (!result) select.value = String(info.disappearingSeconds || info.disappearing_seconds || 0);
    };
    privacy.append(select);
    modal.body.append(privacy);
    const actions = node('div', 'feature-chat-actions');
    const chatActions = [
      [chatIsArchived(info, prefs()) ? 'Desarchivar' : 'Archivar', 'archive'],
      [chatIsPinned(info, prefs()) ? 'Desfijar' : 'Fijar', 'pin'],
      [chatIsMuted(info, prefs()) ? 'Activar sonido' : 'Silenciar', 'mute'],
      [chatIsFavorite(info, prefs()) ? 'Quitar de favoritos' : 'Añadir a favoritos', 'favorite'],
      [Number(info.unread) > 0 || bool(info.unread) ? 'Marcar leído' : 'Marcar no leído', 'read'],
    ];
    for (const [label, action] of chatActions) {
      const control = button(documentRef, label, 'feature-button subtle');
      control.onclick = () => { closeModal(); openChatAction(action); };
      actions.append(control);
    }
    modal.body.append(actions);
  }

  function openMemberForm() {
    const modal = openModal('Añadir miembro', { opener: documentRef.activeElement });
    const address = field(documentRef, 'Número o identificador', 'text', 'memberId');
    const submit = button(documentRef, 'Añadir', 'feature-button primary');
    submit.type = 'submit';
    const form = node('form', 'feature-form');
    form.append(address.wrapper, submit);
    form.onsubmit = async event => {
      event.preventDefault();
      const value = address.input.value.trim();
      if (!value) { address.input.focus(); return; }
      const result = await mutate('/api/groups/action', { action: 'add', participant: value }, { success: 'Miembro añadido.' });
      if (result) { closeModal(); openInfo(); }
    };
    modal.body.append(form);
  }

  function localGallery(kind) {
    if (kind === 'links') return extractLinks(runtime.currentMessages);
    return attachmentItems(runtime.currentMessages, kind);
  }

  async function openGallery(kind) {
    const labels = { media: 'Fotos y vídeos', links: 'Enlaces', documents: 'Documentos' };
    const modal = openModal(labels[kind] || 'Galería', { wide: true });
    const tabs = node('nav', 'feature-gallery-tabs');
    for (const tabKind of ['media', 'links', 'documents']) {
      const tab = button(documentRef, labels[tabKind], `feature-button subtle${tabKind === kind ? ' active' : ''}`);
      tab.onclick = () => { closeModal(); openGallery(tabKind); };
      tabs.append(tab);
    }
    modal.body.append(tabs, node('p', 'feature-loading', 'Cargando…'));
    let items = [];
    try {
      const serverKind = kind === 'media' ? 'gallery' : kind;
      const result = await request('/api/chats/media', undefined, { chat: runtime.chat, kind: serverKind });
      items = array(result.items || result.media || result.results);
    } catch {
      items = localGallery(kind);
    }
    if (!runtime.modal || runtime.modal.body !== modal.body) return;
    const list = node('div', `feature-gallery-grid ${kind === 'links' ? 'links' : ''}`);
    list.replaceChildren();
    if (!items.length) list.append(node('p', 'feature-muted', 'No hay elementos disponibles en este chat.'));
    for (const item of items) {
      const card = node('article', 'feature-gallery-card');
      const url = kind === 'links' ? safeWebUrl(item.url || item.href) : mediaUrl(item, windowRef?.location?.href || 'http://localhost/');
      if (kind === 'media' && url && text(item.mimeType || item.mime_type).startsWith('image/')) {
        const image = node('img', '', text(item.name || 'Imagen'));
        image.src = url; image.alt = text(item.name || 'Imagen'); image.loading = 'lazy';
        image.onerror = () => { image.remove(); card.prepend(node('span', 'feature-gallery-icon', 'IMG')); };
        card.append(image);
      } else card.append(node('span', 'feature-gallery-icon', kind === 'documents' ? 'DOC' : kind === 'links' ? '↗' : 'MEDIA'));
      const copy = node('div', 'feature-gallery-copy');
      copy.append(node('strong', '', item.name || item.fileName || item.file_name || item.title || item.url || 'Elemento'));
      if (item.timestamp) copy.append(node('small', '', new Date(item.timestamp).toLocaleDateString('es-ES')));
      card.append(copy);
      if (url) { card.setAttribute('role', 'link'); card.tabIndex = 0; card.onclick = () => windowRef?.open?.(url, '_blank', 'noopener,noreferrer'); }
      list.append(card);
    }
    modal.body.querySelector('.feature-loading')?.remove();
    modal.body.append(list);
  }

  function openSearch() {
    const modal = openModal('Buscar mensajes', { variant: 'panel' });
    let searchVersion = 0;
    const form = node('form', 'feature-search-form');
    const input = field(documentRef, 'Buscar en este chat o en todo el historial', 'search', 'q');
    const scope = documentRef.createElement('select');
    scope.name = 'scope'; scope.append(option(documentRef, 'Este chat', 'chat'), option(documentRef, 'Todo el historial', 'all'));
    const submit = button(documentRef, 'Buscar', 'feature-button primary');
    submit.type = 'submit';
    form.append(input.wrapper, scope, submit);
    const results = node('div', 'feature-search-results');
    scope.onchange = () => { ++searchVersion; results.replaceChildren(); };
    form.onsubmit = event => {
      event.preventDefault();
      const version = ++searchVersion;
      const context = { account: runtime.account, chat: runtime.chat, generation: runtime.generation };
      const searchScope = scope.value;
      const q = input.input.value.trim();
      const current = () => version === searchVersion && runtime.modal?.body === modal.body && runtime.account === context.account && runtime.chat === context.chat && runtime.generation === context.generation;
      results.replaceChildren();
      if (!q) return;
      const more = button(documentRef, 'Más resultados', 'feature-button');
      let cursor = null;
      let loading = false;
      const loadPage = async () => {
        if (loading || !current()) return;
        loading = true;
        more.disabled = true;
        more.textContent = 'Cargando…';
        results.querySelector('.feature-search-error')?.remove();
        if (!cursor) results.replaceChildren(node('p', 'feature-loading', 'Buscando…'));
        try {
          const page = await request('/api/search', undefined, { chat: searchScope === 'chat' ? context.chat : '', q, scope: searchScope, ...(cursor ? { cursor } : {}) });
          if (!current()) return;
          const found = array(page.results || page.messages || page.items);
          if (!cursor) results.replaceChildren();
          for (const item of found) appendResult(item);
          cursor = page.nextCursor || null;
          more.remove();
          if (cursor) results.append(more);
          else if (!results.children.length) results.append(node('p', 'feature-muted', 'No se encontraron mensajes.'));
        } catch (error) {
          if (!current()) return;
          if (!cursor) results.replaceChildren();
          results.querySelector('.feature-loading')?.remove();
          const errorText = node('p', 'feature-muted feature-search-error', error.message || 'La búsqueda no está disponible.');
          if (cursor) more.before(errorText);
          else results.append(errorText);
        } finally {
          loading = false;
          more.disabled = false;
          more.textContent = 'Más resultados';
        }
      };
      function appendResult(item) {
        const result = button(documentRef, '', 'feature-search-result');
        result.append(node('strong', '', item.chatName || item.chat || runtime.selectedChat?.name || 'Conversación'), node('span', '', messageText(item)), node('small', '', item.timestamp ? new Date(item.timestamp).toLocaleString('es-ES') : ''));
        result.onclick = async () => {
          const target = text(item.chatId || item.chat || runtime.chat);
          if (!target) return;
          const chat = array(getChats()).find(candidate => text(candidate.id) === target) || { id: target, name: item.chatName || target, isGroup: target.endsWith('@g.us') };
          closeModal();
          await selectChat(chat);
          const messageId = text(item.messageId || item.id);
          if (!messageId) return;
          const renderedId = text(runtime.currentMessages.find(message => text(message.id) === messageId || text(message.waMessageId) === messageId)?.id || messageId);
          const bubble = [...documentRef.querySelectorAll('#messages [data-message-id]')].find(element => element.dataset.messageId === renderedId);
          if (bubble) { bubble.tabIndex = -1; bubble.scrollIntoView?.({ block: 'center' }); bubble.focus?.({preventScroll: true}); }
          else {
            try { await showHistoricalMessage(messageId); }
            catch (error) { toast(error.message || 'No se pudo cargar el mensaje encontrado.', 'error'); }
          }
        };
        results.append(result);
      }
      more.onclick = loadPage;
      void loadPage();
    };
    modal.body.append(form, results);
  }

  function replyTo(message) {
    runtime.replyTarget = message;
    const composer = documentRef.getElementById('composer');
    if (!composer) return;
    let quote = documentRef.getElementById('feature-reply-quote');
    if (!quote) { quote = node('div', 'feature-reply-quote'); quote.id = 'feature-reply-quote'; composer.parentElement.insertBefore(quote, composer); }
    quote.replaceChildren(node('span', 'feature-reply-label', 'Respondiendo a'), node('strong', '', messageText(message)));
    const close = button(documentRef, 'Cancelar', 'feature-reply-close');
    close.onclick = clearReply;
    quote.append(close);
    documentRef.getElementById('message')?.focus?.();
    toast('Cita preparada en el borrador.', 'success');
  }

  function clearReply() {
    runtime.replyTarget = null;
    documentRef.getElementById('feature-reply-quote')?.remove();
  }

  function reactionFor(message) {
    const reaction = message?.reactions;
    if (Array.isArray(reaction)) {
      const counts = new Map();
      for (const item of reaction) { const emoji = text(item?.emoji || item?.reaction); if (emoji) counts.set(emoji, (counts.get(emoji) || 0) + (Number(item.count) || 1)); }
      return [...counts].map(([emoji, count]) => ({ emoji, count }));
    }
    if (reaction && typeof reaction === 'object') return Object.entries(reaction).flatMap(([emoji, count]) => [{ emoji, count }]);
    return [];
  }

  function enhanceMessages() {
    const messages = runtime.currentMessages;
    const byId = new Map(messages.map(item => [text(item?.id), item]));
    for (const bubble of documentRef.querySelectorAll('#messages .message[data-message-id]')) {
      const id = text(bubble.dataset.messageId);
      const message = byId.get(id);
      if (!message) continue;
      let action = bubble.querySelector('.feature-message-action');
      if (!action) {
        action = button(documentRef, '⋯', 'feature-message-action');
        action.setAttribute('aria-label', 'Acciones del mensaje');
        action.onclick = event => { event.stopPropagation(); openMessageActions(message); };
        bubble.append(action);
      }
      let selector = bubble.querySelector('.feature-message-select');
      if (runtime.selectedMessageIds.size) {
        if (!selector) {
          selector = documentRef.createElement('input'); selector.type = 'checkbox'; selector.className = 'feature-message-select'; selector.setAttribute('aria-label', 'Seleccionar mensaje');
          selector.onclick = event => { event.stopPropagation(); toggleMessageSelected(id, selector.checked); };
          bubble.prepend(selector);
        }
        selector.checked = runtime.selectedMessageIds.has(id);
      } else selector?.remove();
      const reactions = reactionFor(message);
      let reactionStrip = bubble.querySelector('.feature-reactions');
      if (reactions.length) {
        if (!reactionStrip) { reactionStrip = node('span', 'feature-reactions'); bubble.append(reactionStrip); }
        reactionStrip.replaceChildren();
        for (const item of reactions) reactionStrip.append(node('span', 'feature-reaction', `${item.emoji || item.reaction || ''} ${item.count && item.count > 1 ? item.count : ''}`));
      } else reactionStrip?.remove();
    }
    const toolbar = documentRef.getElementById('feature-selection-toolbar');
    if (toolbar) toolbar.hidden = runtime.selectedMessageIds.size === 0;
  }

  function toggleMessageSelected(id, selected = true) {
    if (selected) runtime.selectedMessageIds.add(text(id)); else runtime.selectedMessageIds.delete(text(id));
    enhanceMessages();
    const count = documentRef.getElementById('feature-selection-count');
    if (count) count.textContent = `${runtime.selectedMessageIds.size} seleccionados`;
  }

  async function reactTo(message, emoji) {
    const result = await mutate('/api/messages/react', { messageId: message.id, emoji }, { refreshMessages: true, success: `Reacción ${emoji} guardada.` });
    if (result) closeModal();
  }

  function openReactionPicker(message) {
    const modal = openModal('Reaccionar', { opener: documentRef.activeElement });
    const grid = node('div', 'feature-emoji-grid');
    for (const emoji of LOCAL_EMOJIS) { const item = button(documentRef, emoji, 'feature-emoji'); item.setAttribute('aria-label', `Reaccionar con ${emoji}`); item.onclick = () => reactTo(message, emoji); grid.append(item); }
    modal.body.append(grid);
  }

  function openForwardPicker(ids) {
    const source = { account: runtime.account, chat: runtime.chat, generation: runtime.generation };
    const messageIds = [...ids];
    const modal = openModal('Reenviar mensaje', { wide: true });
    const form = node('form', 'feature-form');
    const select = documentRef.createElement('select'); select.name = 'targetChat'; select.required = true; select.append(option(documentRef, 'Selecciona una conversación', ''));
    for (const chat of array(getChats()).filter(chat => !chatIsArchived(chat, prefs()))) select.append(option(documentRef, chat.name || chat.id, chat.id));
    const submit = button(documentRef, 'Reenviar', 'feature-button primary');
    submit.type = 'submit';
    form.append(makeElement(documentRef, 'label', 'feature-field', 'Conversación de destino'), select, submit);
    form.onsubmit = async event => {
      event.preventDefault();
      const targetChat = select.value;
      if (!targetChat) return;
      let sent = 0;
      for (const messageId of messageIds) {
        if (runtime.account !== source.account || runtime.chat !== source.chat || runtime.generation !== source.generation) return;
        const result = await mutate('/api/messages/forward', { messageId, targetChat }, { success: '' });
        if (!result) return;
        sent += 1;
      }
      if (sent) { toast(`${sent} mensaje${sent === 1 ? '' : 's'} reenviado${sent === 1 ? '' : 's'}.`, 'success'); runtime.selectedMessageIds.clear(); closeModal(); enhanceMessages(); }
    };
    modal.body.append(form, node('p', 'feature-muted', 'La entrega depende de la confirmación del proveedor.'));
  }

  function openEdit(message) {
    const modal = openModal('Editar mensaje', { opener: documentRef.activeElement });
    const form = node('form', 'feature-form');
    const input = field(documentRef, 'Texto', 'textarea', 'text', text(message.text || message.content));
    const save = button(documentRef, 'Guardar cambios', 'feature-button primary');
    save.type = 'submit';
    form.append(input.wrapper, save);
    form.onsubmit = async event => {
      event.preventDefault();
      const value = input.input.value.trim();
      if (!value) return;
      const result = await mutate('/api/messages/edit', { messageId: message.id, text: value }, { refreshMessages: true, success: 'Mensaje editado.' });
      if (result) closeModal();
    };
    modal.body.append(form);
  }

  function openDelete(message) {
    const modal = openModal('Eliminar mensaje', { opener: documentRef.activeElement });
    modal.body.append(node('p', '', 'Elige si quieres quitar el mensaje solo de tu historial o solicitar su eliminación para todos.'));
    const scope = documentRef.createElement('select'); scope.setAttribute('aria-label', 'Alcance del borrado'); scope.append(option(documentRef, 'Eliminar para mí', 'me'), option(documentRef, 'Eliminar para todos', 'everyone'));
    const confirm = button(documentRef, 'Eliminar', 'feature-button danger');
    confirm.onclick = async () => { const result = await mutate('/api/messages/delete', { messageId: message.id, scope: scope.value }, { refreshMessages: true, success: 'Mensaje eliminado.' }); if (result) closeModal(); };
    modal.body.append(scope, confirm);
  }

  async function starMessage(message, starred = true) {
    const result = await mutate('/api/chat-actions', { action: starred ? 'starred' : 'unstarred', messageId: message.id }, { refreshMessages: true, success: starred ? 'Mensaje destacado.' : 'Mensaje desmarcado.' });
    if (result) {
      savePrefs(current => { const ids = new Set(current.starredMessages); if (starred) ids.add(text(message.id)); else ids.delete(text(message.id)); return { ...current, starredMessages: [...ids] }; });
      closeModal();
    }
  }

  function openMessageActions(message) {
    const modal = openModal('Acciones del mensaje', { opener: documentRef.activeElement, variant: 'menu' });
    const actions = node('div', 'feature-action-grid');
    const add = (label, handler, className = 'feature-button subtle') => { const item = button(documentRef, label, className); item.onclick = () => handler(message); actions.append(item); };
    add('Responder', item => { closeModal(); replyTo(item); });
    add('Reaccionar', item => { closeModal(); openReactionPicker(item); });
    add('Reenviar', item => { closeModal(); openForwardPicker([text(item.id)]); });
    add('Seleccionar', item => { closeModal(); toggleMessageSelected(item.id, true); });
    add(prefs().starredMessages.includes(text(message.id)) ? 'Quitar destacado' : 'Destacar', item => starMessage(item, !prefs().starredMessages.includes(text(item.id))));
    if (message.fromMe === true) {
      add('Editar', item => { closeModal(); openEdit(item); });
      add('Eliminar', item => { closeModal(); openDelete(item); }, 'feature-button danger');
    }
    modal.body.append(actions);
  }

  async function openChatAction(action) {
    if (!runtime.chat) return;
    if (action === 'read') {
      const unread = Number(runtime.selectedChat?.unread) > 0 || bool(runtime.selectedChat?.unread);
      const result = await mutate('/api/chat-actions', { action: unread ? 'read' : 'unread' }, { refreshChats: true, success: unread ? 'Chat marcado como leído.' : 'Chat marcado como no leído.' });
      if (result) updateChatFlags(runtime.chat, { unread: unread ? 0 : 1 });
      return;
    }
    const fieldName = { archive: 'archived', pin: 'pinned', mute: 'muted', favorite: 'favorite' }[action];
    if (!fieldName) return;
    const currentValue = { archived: chatIsArchived(runtime.selectedChat, prefs()), pinned: chatIsPinned(runtime.selectedChat, prefs()), muted: chatIsMuted(runtime.selectedChat, prefs()), favorite: chatIsFavorite(runtime.selectedChat, prefs()) }[fieldName];
    const providerAction = action === 'archive' ? (currentValue ? 'unarchive' : 'archive') : action === 'pin' ? (currentValue ? 'unpin' : 'pin') : action === 'mute' ? (currentValue ? 'unmute' : 'mute') : (currentValue ? 'unfavorite' : 'favorite');
    const result = await mutate('/api/chat-actions', { action: providerAction }, { refreshChats: true, success: `${fieldName === 'archived' ? (!currentValue ? 'Chat archivado.' : 'Chat desarchivado.') : 'Preferencia actualizada.'}` });
    if (result) updateChatFlags(runtime.chat, { [fieldName]: !currentValue });
  }

  function openChatMenu() {
    const modal = openModal('Opciones de conversación', { opener: documentRef.activeElement });
    const actions = node('div', 'feature-action-grid');
    const add = (label, action) => { const item = button(documentRef, label, 'feature-button subtle'); item.onclick = () => { closeModal(); action(); }; actions.append(item); };
    add('Información', openInfo);
    add(chatIsArchived(runtime.selectedChat, prefs()) ? 'Desarchivar' : 'Archivar', () => openChatAction('archive'));
    add(chatIsPinned(runtime.selectedChat, prefs()) ? 'Desfijar' : 'Fijar', () => openChatAction('pin'));
    add(chatIsMuted(runtime.selectedChat, prefs()) ? 'Activar sonido' : 'Silenciar', () => openChatAction('mute'));
    add(chatIsFavorite(runtime.selectedChat, prefs()) ? 'Quitar de favoritos' : 'Añadir a favoritos', () => openChatAction('favorite'));
    add('Listas', openLists);
    add('Privacidad', openPrivacy);
    modal.body.append(actions);
  }

  function openLists() {
    const modal = openModal('Favoritos y listas', { wide: true });
    const current = prefs();
    const form = node('form', 'feature-form');
    const input = field(documentRef, 'Nueva lista', 'text', 'name');
    const submit = button(documentRef, 'Crear lista', 'feature-button primary');
    submit.type = 'submit';
    form.append(input.wrapper, submit);
    form.onsubmit = async event => {
      event.preventDefault(); const name = input.input.value.trim(); if (!name) return;
      savePrefs(value => ({ ...value, lists: [...value.lists, { id: cryptoRandom(), name, chatIds: [] }] }));
      toast('Lista local creada.', 'success'); closeModal(); openLists();
    };
    modal.body.append(form, node('p', 'feature-muted', 'Las listas se guardan en este navegador para esta cuenta. La pertenencia también se registra en el servidor.'));
    addSection(modal.body, 'Listas guardadas');
    if (!current.lists.length) modal.body.append(node('p', 'feature-muted', 'Todavía no hay listas.'));
    for (const list of current.lists) {
      const row = node('div', 'feature-list-row'); row.append(node('strong', '', list.name), node('span', 'feature-muted', `${list.chatIds.length} chats`));
      const show = button(documentRef, 'Ver', 'feature-button subtle');
      show.onclick = () => { closeModal(); setView(`list:${list.id}`); };
      const addChat = button(documentRef, 'Añadir chat actual', 'feature-button subtle');
      addChat.disabled = !runtime.chat || list.chatIds.includes(runtime.chat);
      addChat.onclick = async () => { const result = await mutate('/api/lists', { action: 'list', list: list.name, id: runtime.chat }, { success: 'Chat añadido a la lista.' }); if (result) { savePrefs(value => ({ ...value, lists: value.lists.map(item => item.id === list.id ? { ...item, chatIds: [...new Set([...item.chatIds, runtime.chat])] } : item) })); closeModal(); openLists(); } };
      const removeChat = button(documentRef, 'Quitar chat actual', 'feature-button subtle');
      removeChat.disabled = !runtime.chat || !list.chatIds.includes(runtime.chat);
      removeChat.onclick = async () => { const result = await mutate('/api/lists', { action: 'remove-from-list', list: list.name, id: runtime.chat }, { success: 'Chat quitado de la lista.' }); if (result) { savePrefs(value => ({ ...value, lists: value.lists.map(item => item.id === list.id ? { ...item, chatIds: item.chatIds.filter(id => id !== runtime.chat) } : item) })); closeModal(); openLists(); } };
      const removeList = button(documentRef, 'Eliminar lista local', 'feature-button subtle');
      removeList.onclick = () => { if (!windowRef?.confirm?.(`¿Eliminar la lista local ${list.name}?`)) return; savePrefs(value => ({ ...value, view: value.view === `list:${list.id}` ? 'all' : value.view, lists: value.lists.filter(item => item.id !== list.id) })); closeModal(); openLists(); renderChats(); };
      row.append(show, addChat, removeChat, removeList); modal.body.append(row);
    }
  }

  function cryptoRandom() { return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

  async function openStarred() {
    const modal = openModal('Mensajes destacados', { wide: true });
    const account = runtime.account;
    const loadPage = async before => {
      let result;
      try { result = await request('/api/favorites/starred', undefined, { limit: '100', ...(before ? { before } : {}) }); }
      catch (error) { if (runtime.modal?.body === modal.body) modal.body.append(node('p', 'feature-muted', error.message || 'No se pudieron cargar los mensajes destacados.')); return; }
      if (runtime.account !== account || runtime.modal?.body !== modal.body) return;
      modal.body.querySelector('.feature-load-more')?.remove();
      const items = array(result.items);
      if (!items.length && !before) { modal.body.append(node('p', 'feature-muted', 'No hay mensajes destacados.')); return; }
      for (const item of items) {
        const row = button(documentRef, '', 'feature-search-result');
        row.append(node('strong', '', item.chatName || item.chatId || 'Conversación'), node('span', '', messageText(item)));
        row.onclick = () => { const id = text(item.chatId); if (!id) return; const chat = array(getChats()).find(candidate => text(candidate.id) === id) || { id, name: item.chatName || id }; closeModal(); selectChat(chat); };
        modal.body.append(row);
      }
      if (result.nextCursor) { const more = button(documentRef, 'Mostrar más', 'feature-button subtle feature-load-more'); more.onclick = () => loadPage(text(result.nextCursor)); modal.body.append(more); }
    };
    await loadPage('');
  }

  function openNewChat() {
    const modal = openModal('Nuevo chat', { wide: true });
    const type = documentRef.createElement('select'); type.setAttribute('aria-label', 'Tipo de acción'); type.append(option(documentRef, 'Iniciar chat', 'chat'), option(documentRef, 'Nuevo contacto', 'contact'), option(documentRef, 'Nuevo grupo', 'group'));
    const form = node('form', 'feature-form');
    const name = field(documentRef, 'Nombre', 'text', 'name');
    const address = field(documentRef, 'Número o identificador', 'text', 'address');
    const members = field(documentRef, 'Miembros (separados por comas, solo grupos)', 'text', 'members');
    const submit = button(documentRef, 'Continuar', 'feature-button primary');
    submit.type = 'submit';
    form.append(makeElement(documentRef, 'label', 'feature-field', 'Operación'), type, name.wrapper, address.wrapper, members.wrapper, submit);
    const hint = node('p', 'feature-muted', 'Las operaciones de contacto y grupo requieren permisos del proveedor.');
    function updateFields() { members.wrapper.hidden = type.value !== 'group'; name.wrapper.hidden = type.value === 'chat'; }
    type.onchange = updateFields; updateFields();
    form.onsubmit = async event => {
      event.preventDefault();
      const values = formData(form); const selected = type.value;
      const route = selected === 'contact' ? '/api/contacts' : selected === 'group' ? '/api/groups' : '/api/chats/new';
      const payload = selected === 'group' ? { name: values.name.trim(), participants: values.members.split(',').map(item => item.trim()).filter(Boolean) } : selected === 'contact' ? { phone: values.address.trim(), displayName: values.name.trim() } : { phone: values.address.trim() };
      if (selected === 'group' && (!payload.name || !payload.participants.length)) return;
      if (selected !== 'group' && !payload.phone) return;
      const result = await mutate(route, payload, { refreshChats: true, success: selected === 'chat' ? 'Chat abierto.' : 'Operación confirmada.' });
      const chat = result?.chat || result?.conversation;
      if (chat) { closeModal(); selectChat(chat); }
      else if (result?.confirmed) closeModal();
    };
    modal.body.append(form, hint);
  }

  function openPicker() {
    const modal = openModal('Emoji, GIF y stickers', { wide: true });
    const tabs = node('nav', 'feature-picker-tabs');
    const content = node('div', 'feature-picker-content');
    const renderEmoji = () => { content.replaceChildren(); const grid = node('div', 'feature-emoji-grid'); for (const emoji of LOCAL_EMOJIS) { const item = button(documentRef, emoji, 'feature-emoji'); item.onclick = () => insertEmoji(emoji); grid.append(item); } content.append(grid); };
    const renderUpload = (kind, accept) => {
      content.replaceChildren(node('p', 'feature-muted', `Selecciona un archivo local de ${kind}. No se usa un servicio externo.`));
      const input = documentRef.createElement('input'); input.type = 'file'; input.accept = accept; input.setAttribute('aria-label', `Subir ${kind}`);
      const send = button(documentRef, `Enviar ${kind}`, 'feature-button primary'); send.disabled = true;
      let sendToken = '';
      input.onchange = () => { runtime.composeFile = input.files?.[0] || null; sendToken = ''; send.disabled = !runtime.composeFile; };
      send.onclick = async () => {
        if (!runtime.composeFile) return;
        const file = runtime.composeFile;
        let data; try { data = await readBase64(file); } catch (error) { toast(error.message, 'error'); return; }
        sendToken ||= crypto.randomUUID();
        const result = await mutate('/api/messages/compose', { kind: kind === 'sticker' ? 'sticker' : 'gif', name: file.name, mimeType: file.type || 'application/octet-stream', data, sendToken }, { refreshMessages: true, success: `${kind} enviado.` });
        if (result) { runtime.composeFile = null; closeModal(); }
      };
      content.append(input, send);
    };
    const addTab = (label, render) => { const tab = button(documentRef, label, 'feature-button subtle'); tab.onclick = () => { for (const item of tabs.children) item.classList.remove('active'); tab.classList.add('active'); render(); }; tabs.append(tab); return tab; };
    addTab('Emoji', renderEmoji).click(); addTab('GIF local', () => renderUpload('GIF', 'image/gif')); addTab('Sticker local', () => renderUpload('sticker', 'image/webp'));
    modal.body.append(tabs, content);
  }

  function insertEmoji(emoji) {
    const input = documentRef.getElementById('message');
    if (!input) return;
    const start = input.selectionStart ?? input.value.length; const end = input.selectionEnd ?? input.value.length;
    input.value = `${input.value.slice(0, start)}${emoji}${input.value.slice(end)}`;
    input.selectionStart = input.selectionEnd = start + emoji.length;
    input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
  }

  function openShare(type) {
    const labels = { contact: 'Compartir contacto', poll: 'Crear encuesta', event: 'Crear evento' };
    const modal = openModal(labels[type] || 'Compartir', { opener: documentRef.activeElement });
    const form = node('form', 'feature-form');
    const fields = type === 'contact' ? [field(documentRef, 'Nombre', 'text', 'name'), field(documentRef, 'Número o identificador', 'text', 'address')] : type === 'poll' ? [field(documentRef, 'Pregunta', 'text', 'question'), field(documentRef, 'Opciones separadas por comas', 'text', 'options')] : [field(documentRef, 'Título', 'text', 'title'), field(documentRef, 'Fecha y hora', 'datetime-local', 'dateTime'), field(documentRef, 'Lugar o enlace', 'text', 'location')];
    const submit = button(documentRef, `Enviar ${type === 'contact' ? 'contacto' : type === 'poll' ? 'encuesta' : 'evento'}`, 'feature-button primary');
    submit.type = 'submit';
    for (const item of fields) form.append(item.wrapper); form.append(submit);
    let lastPayload = ''; let sendToken = '';
    form.onsubmit = async event => { event.preventDefault(); const values = formData(form); if (type === 'poll') values.options = values.options.split(',').map(item => item.trim()).filter(Boolean); const signature = JSON.stringify(values); if (signature !== lastPayload) { sendToken = crypto.randomUUID(); lastPayload = signature; } const result = await mutate('/api/messages/compose', { kind: type, payload: values, sendToken }, { refreshMessages: true, success: 'Contenido preparado para enviar.' }); if (result) closeModal(); };
    modal.body.append(form, node('p', 'feature-muted', 'La entrega queda confirmada por el proveedor; no se muestra como enviada antes de esa respuesta.'));
  }

  async function openPrivacy() {
    const modal = openModal('Privacidad', { wide: true });
    const form = node('form', 'feature-form');
    const profile = documentRef.createElement('select'); profile.name = 'profile'; profile.append(option(documentRef, 'Sin datos', ''), option(documentRef, 'Todos', 'all'), option(documentRef, 'Mis contactos', 'contacts'), option(documentRef, 'Nadie', 'none'));
    const lastSeen = documentRef.createElement('select'); lastSeen.name = 'lastSeen'; lastSeen.append(option(documentRef, 'Sin datos', ''), option(documentRef, 'Todos', 'all'), option(documentRef, 'Mis contactos', 'contacts'), option(documentRef, 'Nadie', 'none'));
    const receipts = documentRef.createElement('select'); receipts.name = 'readReceipts'; receipts.append(option(documentRef, 'Sin datos', ''), option(documentRef, 'Activados', 'true'), option(documentRef, 'Desactivados', 'false'));
    for (const [label, control] of [['Foto y perfil', profile], ['Última vez', lastSeen], ['Confirmaciones de lectura', receipts]]) { const wrapper = node('label', 'feature-field'); wrapper.append(node('span', '', label), control); form.append(wrapper); }
    const submit = button(documentRef, 'Guardar privacidad', 'feature-button primary'); submit.disabled = true; form.append(submit);
    submit.type = 'submit';
    let loaded = false;
    let initial = normalizePrivacySnapshot();
    form.onsubmit = async event => {
      event.preventDefault();
      if (!loaded) return;
      const current = normalizePrivacySnapshot({ profile: profile.value, lastSeen: lastSeen.value, readReceipts: receipts.value });
      const changes = privacyChanges(initial, current);
      for (const change of changes) {
        const result = await mutate('/api/privacy', change, { success: '', includeChat: false });
        if (!result) return;
      }
      if (changes.length) toast('Privacidad actualizada.', 'success');
      closeModal();
    };
    const notice = node('p', 'feature-muted', 'Cargando preferencias…');
    modal.body.append(notice, form);
    try {
      const result = await request('/api/privacy', undefined, { chat: '' });
      initial = normalizePrivacySnapshot(result);
      profile.value = initial.profile || '';
      lastSeen.value = initial.lastSeen || '';
      receipts.value = initial.readReceipts || '';
      loaded = true;
      submit.disabled = false;
      notice.textContent = 'Solo se muestran preferencias respaldadas por la sesión y el proveedor.';
    } catch {
      notice.textContent = 'No se pudieron cargar las preferencias actuales; Guardar permanece desactivado.';
    }
  }

  async function readNotifications() {
    if (!windowRef?.Notification) { toast('Este navegador no ofrece notificaciones de escritorio.', 'error'); return; }
    if (windowRef.Notification.permission === 'granted') { toast('Las notificaciones ya están activadas.', 'success'); return; }
    if (windowRef.Notification.permission === 'denied') { toast('El navegador bloqueó las notificaciones. Actívalas desde los permisos del sitio.', 'error'); return; }
    try {
      const permission = await windowRef.Notification.requestPermission();
      runtime.notificationPermission = permission;
      toast(permission === 'granted' ? 'Notificaciones activadas.' : 'No se activaron las notificaciones.', permission === 'granted' ? 'success' : 'error');
    } catch { toast('No se pudo solicitar el permiso de notificaciones.', 'error'); }
  }

  function chatListChanged(chats) {
    const account = runtime.account;
    const current = new Map(array(chats).map(chat => [text(chat?.id), {
      timestamp: chat?.timestamp || '',
      unread: Number(chat?.unread) || 0,
      preview: text(chat?.preview).trim(),
      name: text(chat?.name || chat?.id || 'SocialMedia'),
      muted: chatIsMuted(chat, prefs()),
    }]));
    const firstSnapshot = ![...runtime.chatListBaseline.keys()].some(key => key.startsWith(`${account}:`));
    for (const [chatId, next] of current) {
      const key = `${account}:${chatId}`;
      const previous = runtime.chatListBaseline.get(key);
      runtime.chatListBaseline.set(key, next);
      if (chatId === runtime.chat) {
        runtime.selectedChat = array(chats).find(chat => text(chat?.id) === chatId) || runtime.selectedChat;
        if (next.unread > 0) void markVisibleRead();
      }
      if (firstSnapshot || !shouldNotifyChatUpdate(previous, next, { hidden: documentRef.hidden, permission: runtime.notificationPermission, muted: next.muted })) continue;
      try {
        new windowRef.Notification(next.name, {
          body: next.preview || 'Nuevo mensaje',
          tag: `socialmedia-${account}-${chatId}-${next.timestamp || next.unread}`,
        });
      } catch { /* Notification delivery is optional. */ }
    }
  }

  function addHeaderControls() {
    const sidebarHeader = documentRef.querySelector('.chat-sidebar-header');
    const sidebarActions = node('div', 'chat-sidebar-actions');
    const newChat = button(documentRef, '+', 'sidebar-action sidebar-action-new'); newChat.id = 'feature-new-chat'; newChat.setAttribute('aria-label', 'Nuevo chat'); newChat.title = 'Nuevo chat'; newChat.onclick = openNewChat;
    const lists = button(documentRef, '☆', 'sidebar-action sidebar-action-favorites'); lists.id = 'feature-lists'; lists.setAttribute('aria-label', 'Favoritos y listas'); lists.title = 'Favoritos y listas'; lists.onclick = openLists;
    sidebarActions.append(newChat, lists); sidebarHeader?.append(sidebarActions);
    const search = documentRef.querySelector('.chat-sidebar > .search');
    const views = node('nav', 'feature-view-nav'); views.setAttribute('aria-label', 'Vistas de conversaciones');
    for (const [label, view] of [['Todos', 'all'], ['No leídos', 'unread'], ['Grupos', 'groups'], ['Favoritos', 'favorites'], ['Destacados', 'starred']]) {
      const item = button(documentRef, label, 'feature-view-button'); item.dataset.featureView = view; item.setAttribute('aria-pressed', String(runtime.currentView === view)); item.onclick = () => view === 'starred' ? openStarred() : setView(view); views.append(item);
    }
    search?.after(views);
    const archiveTitle = node('header', 'feature-archive-title'); archiveTitle.id = 'feature-archived-title'; archiveTitle.hidden = true;
    const archiveBack = button(documentRef, '←', 'feature-archive-back'); archiveBack.setAttribute('aria-label', 'Volver a los chats'); archiveBack.onclick = () => setView('all');
    archiveTitle.append(archiveBack, node('h2', '', 'Archivados'));
    sidebarHeader?.after(archiveTitle);
    const archiveEntry = button(documentRef, 'Archivados', 'feature-archive-entry'); archiveEntry.id = 'feature-archived-entry'; archiveEntry.setAttribute('aria-pressed', String(runtime.currentView === 'archived'));
    const archiveIcon = node('span', 'feature-archive-icon', '▤'); archiveIcon.setAttribute('aria-hidden', 'true'); archiveEntry.prepend(archiveIcon);
    archiveEntry.onclick = () => setView('archived');
    views.after(archiveEntry);
    const archiveHint = node('p', 'feature-archive-hint', 'Estos chats permanecen archivados y no aparecen en la lista principal.'); archiveHint.id = 'feature-archived-hint'; archiveHint.hidden = true;
    documentRef.getElementById('chats')?.before(archiveHint);
    updateArchiveView();
    const conversationActions = documentRef.querySelector('.conversation-actions');
    const addHeader = (id, label, title, handler) => { const item = button(documentRef, label, 'header-icon'); item.id = id; item.setAttribute('aria-label', title); item.title = title; item.onclick = handler; conversationActions?.append(item); return item; };
    addHeader('feature-chat-search', '⌕', 'Buscar mensajes', openSearch);
    addHeader('feature-chat-info', 'ⓘ', 'Información del chat', openInfo);
    addHeader('feature-chat-menu', '⋮', 'Opciones de chat', openChatMenu);
    const toolbar = node('div', 'feature-selection-toolbar'); toolbar.id = 'feature-selection-toolbar'; toolbar.hidden = true;
    const count = node('span', '', '0 seleccionados'); count.id = 'feature-selection-count';
    const forward = button(documentRef, 'Reenviar', 'feature-button subtle'); forward.onclick = () => openForwardPicker(runtime.selectedMessageIds);
    const star = button(documentRef, 'Destacar', 'feature-button subtle'); star.onclick = async () => { for (const id of runtime.selectedMessageIds) { const message = runtime.currentMessages.find(item => text(item.id) === id); if (message) await starMessage(message, true); } runtime.selectedMessageIds.clear(); enhanceMessages(); };
    const cancel = button(documentRef, 'Cancelar', 'feature-button subtle'); cancel.onclick = () => { runtime.selectedMessageIds.clear(); enhanceMessages(); };
    toolbar.append(count, forward, star, cancel); documentRef.querySelector('.conversation-header')?.after(toolbar);
    const composer = documentRef.getElementById('composer');
    const emoji = button(documentRef, '☺', 'composer-icon'); emoji.id = 'feature-emoji'; emoji.setAttribute('aria-label', 'Emoji, GIF y stickers'); emoji.title = 'Emoji, GIF y stickers'; emoji.onclick = openPicker; composer?.prepend(emoji);
    const attachment = documentRef.getElementById('attach');
    const originalAttachmentClick = attachment?.onclick;
    const attachMenu = node('div', 'feature-attach-menu'); attachMenu.id = 'feature-attach-menu'; attachMenu.hidden = true; attachMenu.setAttribute('role', 'menu'); attachMenu.setAttribute('aria-label', 'Adjuntar');
    const closeAttachMenu = () => { attachMenu.hidden = true; attachment?.setAttribute('aria-expanded', 'false'); };
    runtime.closeAttachMenu = closeAttachMenu;
    const fileInput = documentRef.getElementById('attachment');
    const allAccept = fileInput?.accept || '';
    const openFile = accept => { if (fileInput) fileInput.accept = accept; originalAttachmentClick?.(); };
    fileInput?.addEventListener('change', () => { fileInput.accept = allAccept; });
    const attachPaths = {
      photo: ['M3 5h18v14H3z', 'M8 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'm4 17 5-5 3 3 2-2 4 4'],
      document: ['M6 2h8l4 4v16H6z', 'M14 2v5h5', 'M9 12h6', 'M9 16h6'],
      contact: ['M4 5h16v14H4z', 'M10 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M6.5 16c0-2 1.5-3 3.5-3s3.5 1 3.5 3', 'M16 10h2', 'M16 13h2'],
      poll: ['M5 5h3v3H5z', 'M11 6h8', 'M5 11h3v3H5z', 'M11 12h8', 'M5 17h3v3H5z', 'M11 18h8'],
      event: ['M4 5h16v16H4z', 'M4 9h16', 'M8 3v4', 'M16 3v4', 'M8 13h3', 'M8 17h3'],
    };
    const addAttach = (label, tone, handler) => {
      const item = button(documentRef, '', 'feature-attach-option'); item.setAttribute('role', 'menuitem'); item.setAttribute('aria-label', label);
      const symbol = node('span', `feature-attach-symbol ${tone}`); symbol.setAttribute('aria-hidden', 'true');
      const icon = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24');
      for (const pathValue of attachPaths[tone]) { const path = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', pathValue); icon.append(path); }
      symbol.append(icon); item.append(symbol, node('span', '', label)); item.onclick = () => { closeAttachMenu(); handler(); }; attachMenu.append(item);
    };
    addAttach('Fotos y vídeos', 'photo', () => openFile('image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime'));
    addAttach('Documento', 'document', () => openFile('.pdf,.docx,.xlsx,.pptx,.zip,.txt'));
    addAttach('Contacto', 'contact', () => openShare('contact'));
    addAttach('Encuesta', 'poll', () => openShare('poll'));
    addAttach('Evento', 'event', () => openShare('event'));
    composer?.append(attachMenu);
    if (attachment) {
      attachment.setAttribute('aria-haspopup', 'menu'); attachment.setAttribute('aria-controls', 'feature-attach-menu'); attachment.setAttribute('aria-expanded', 'false');
      attachment.onclick = () => { attachMenu.hidden = !attachMenu.hidden; attachment.setAttribute('aria-expanded', String(!attachMenu.hidden)); if (!attachMenu.hidden) attachMenu.querySelector('button')?.focus(); };
      documentRef.addEventListener('pointerdown', event => { if (!attachMenu.hidden && !attachMenu.contains(event.target) && !attachment.contains(event.target)) closeAttachMenu(); });
      documentRef.addEventListener('keydown', event => { if (event.key === 'Escape' && !attachMenu.hidden) { closeAttachMenu(); attachment.focus(); } });
    }
    const settings = documentRef.querySelector('.rail-popover');
    const notifications = button(documentRef, 'Activar notificaciones', 'feature-button subtle'); notifications.id = 'feature-notifications'; notifications.onclick = readNotifications;
    const privacy = button(documentRef, 'Privacidad', 'feature-button subtle'); privacy.id = 'feature-privacy'; privacy.onclick = openPrivacy;
    settings?.append(notifications, privacy);
  }

  function getSendPayload() {
    return runtime.replyTarget ? { replyTo: runtime.replyTarget.id } : {};
  }

  function sendConfirmed() { clearReply(); }

  function restoreReply(messageId) {
    const message = runtime.currentMessages.find(item => text(item.id) === text(messageId) || text(item.waMessageId) === text(messageId));
    if (!message || !runtime.chat || (message.account && text(message.account) !== runtime.account) || (message.chat && text(message.chat) !== runtime.chat)) return false;
    replyTo(message);
    return true;
  }

  function accountChanged(account) {
    clearInterval(runtime.presenceTimer); runtime.presenceTimer = null;
    runtime.closeAttachMenu?.();
    closeModal(); runtime.generation += 1; runtime.account = text(account); runtime.chat = ''; runtime.selectedChat = null; runtime.currentMessages = []; runtime.selectedMessageIds.clear(); runtime.replyTarget = null; runtime.currentView = store.read(runtime.account).view; state.chatFilter = runtime.currentView; runtime.readPending.clear(); runtime.chatListBaseline.clear(); documentRef.getElementById('feature-reply-quote')?.remove(); for (const item of documentRef.querySelectorAll('[data-feature-view]')) item.setAttribute('aria-pressed', String(item.dataset.featureView === runtime.currentView)); updateArchiveView();
  }

  async function markVisibleRead() {
    const chat = runtime.chat;
    const account = runtime.account;
    const key = `${account}:${chat}`;
    if (!canMarkVisibleRead({ hidden: documentRef.hidden, visibilityState: documentRef.visibilityState, account, chat }) || runtime.readPending.has(key)) return;
    if (!documentRef.body.classList.contains('chat-open')) return;
    if (!(Number(runtime.selectedChat?.unread) > 0 || bool(runtime.selectedChat?.unread))) return;
    runtime.readPending.add(key);
    const result = await mutate('/api/chat-actions', { action: 'read' }, { refreshChats: true, success: '' });
    runtime.readPending.delete(key);
    if (result && runtime.account === account && runtime.chat === chat) updateChatFlags(chat, { unread: 0 });
  }

  function chatChanged(chat) {
    clearInterval(runtime.presenceTimer); runtime.presenceTimer = null;
    runtime.closeAttachMenu?.();
    closeModal(); runtime.generation += 1; runtime.selectedChat = chat; runtime.chat = text(chat?.id); runtime.currentMessages = []; runtime.currentMessageIds.clear(); runtime.selectedMessageIds.clear(); clearReply(); enhanceMessages();
    if (chat?.isGroup !== true && runtime.chat) {
      const account = runtime.account; const chatId = runtime.chat; const generation = runtime.generation;
      void refreshHeaderPresence(account, chatId, generation, true);
      runtime.presenceTimer = setInterval(() => { if (!documentRef.hidden) void refreshHeaderPresence(account, chatId, generation); }, 20000);
    }
    void markVisibleRead();
  }

  async function refreshHeaderPresence(account, chat, generation, subscribe = false) {
    const subtitle = documentRef.getElementById('chat-subtitle');
    const key = `${account}:${chat}:${generation}`;
    if (!subtitle || runtime.presencePending.has(key) || runtime.account !== account || runtime.chat !== chat || runtime.generation !== generation) return;
    runtime.presencePending.add(key);
    try {
      if (subscribe) {
        try { await request('/api/presence/subscribe', { account, chat }); } catch { /* Some providers do not support subscriptions. */ }
      }
      if (runtime.account !== account || runtime.chat !== chat || runtime.generation !== generation) return;
      const presence = await request('/api/presence', undefined, { chat });
      if (runtime.account === account && runtime.chat === chat && runtime.generation === generation) {
        subtitle.textContent = visiblePresenceLabel(presence) || 'Contacto';
      }
    } catch { /* Keep the neutral contact label. */ }
    finally { runtime.presencePending.delete(key); }
  }

  function messagesChanged(messages) {
    runtime.currentMessages = array(messages); runtime.currentMessageIds = new Set(runtime.currentMessages.map(item => text(item.id)).filter(Boolean)); enhanceMessages();
  }

  documentRef.addEventListener?.('visibilitychange', () => { if (!documentRef.hidden) { void markVisibleRead(); if (runtime.chat && runtime.selectedChat?.isGroup !== true) void refreshHeaderPresence(runtime.account, runtime.chat, runtime.generation); } });
  windowRef?.addEventListener?.('pagehide', () => { clearInterval(runtime.presenceTimer); runtime.presenceTimer = null; });

  addHeaderControls();
  return {
    matchesChat,
    accountChanged,
    chatsChanged: chatListChanged,
    chatChanged,
    messagesChanged,
    getSendPayload,
    sendConfirmed,
    restoreReply,
    openInfo,
    openSearch,
    openChatMenu,
    setView,
    isFeatureView: () => runtime.currentView,
    getState: () => ({ ...runtime, selectedMessageIds: new Set(runtime.selectedMessageIds) }),
  };
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(text(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

export { FeatureStore };
