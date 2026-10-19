import test from 'node:test';
import assert from 'node:assert/strict';
import { installFeatureUI } from '../public/features-ui.mjs';
import {
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_EMPTY_BODY,
  NOTIFICATION_HIDDEN_BODY,
  NOTIFICATION_HIDDEN_TITLE,
  NOTIFICATION_REACTION_BODY,
  NOTIFICATION_REACTION_HIDDEN_BODY,
  NOTIFICATION_STORAGE_PREFIX,
  createNotificationStore,
  installNotificationSettings,
  notificationPayload,
  reactionNotificationPayload,
  statusNotificationPayload,
  notificationPermissionLabel,
  normalizeNotificationPreferences,
} from '../public/notification-settings.mjs';

const ALPHA = 'alpha';
const BETA = 'beta';
const alphaKey = `${NOTIFICATION_STORAGE_PREFIX}alpha`;
const betaKey = `${NOTIFICATION_STORAGE_PREFIX}beta`;

/* ----------------------------------------------------------------- dom shim */

const dataKey = name => name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function matches(element, selector) {
  return String(selector).split(',').map(part => part.trim()).filter(Boolean).some(part => {
    const tokens = part.match(/\[[^\]]+\]|[.#]?[A-Za-z0-9_-]+/g) || [];
    return tokens.length > 0 && tokens.every(token => {
      if (token.startsWith('[')) {
        const [name, ...rest] = token.slice(1, -1).split('=');
        if (!rest.length) return element.getAttribute(name) !== null;
        const wanted = rest.join('=').replace(/^["']|["']$/g, '');
        const key = dataKey(name);
        const attribute = element.getAttribute(name);
        const have = key in element.dataset ? element.dataset[key] : (attribute !== null ? attribute : element[name]);
        return have !== null && String(have) === wanted;
      }
      if (token.startsWith('#')) return element.id === token.slice(1);
      if (token.startsWith('.')) return element.className.split(/\s+/).includes(token.slice(1));
      return element.tagName === token;
    });
  });
}

function descend(element) {
  return element.children.flatMap(child => [child, ...descend(child)]);
}

class Element {
  constructor(tag, doc = null) {
    this.tagName = String(tag);
    this.doc = doc;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.id = '';
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.hidden = false;
    this._type = '';
    this.checked = false;
    this.disabled = false;
    this.onclick = null;
    this._text = '';
    this._root = false;
    this.style = { setProperty: () => {} };
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node._root === true;
  }

  get textContent() { return [this._text, ...this.children.map(child => child.textContent)].filter(Boolean).join(' '); }

  set textContent(value) { this.children = []; this._text = value == null ? '' : String(value); }

  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      node.parentNode?.remove?.();
      node.parentNode = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
  }

  remove() { this.parentNode?.removeChild?.(this); }

  insert(node, offset) {
    const parent = this.parentNode;
    if (!parent) return;
    node.parentNode?.remove?.();
    node.parentNode = parent;
    parent.children.splice(Math.max(0, parent.children.indexOf(this) + offset), 0, node);
  }

  before(node) { this.insert(node, 0); }

  prepend(node) {
    node.parentNode?.remove?.();
    node.parentNode = this;
    this.children.unshift(node);
  }

  get type() { return this._type; }

  set type(value) { this._type = String(value); this.attributes.type = String(value); }

  getElementById(id) { return descend(this).find(element => element.id === id) || null; }

  after(node) { this.insert(node, 1); }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'hidden') this.hidden = true;
  }

  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }

  removeAttribute(name) { delete this.attributes[name]; }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  }

  dispatch(type) {
    const event = { type, target: this, preventDefault: () => {}, stopPropagation: () => {} };
    for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
    return event;
  }

  click() {
    const event = { type: 'click', target: this, preventDefault: () => {}, stopPropagation: () => {} };
    this.onclick?.(event);
    this.dispatch('click');
    if (this.tagName === 'input' && this.type === 'checkbox') {
      this.checked = !this.checked;
      this.dispatch('change');
    }
    return event;
  }

  focus() { if (this.doc) this.doc.activeElement = this; }

  querySelector(selector) { return descend(this).find(child => matches(child, selector)) || null; }

  querySelectorAll(selector) { return descend(this).filter(child => matches(child, selector)); }
}

/** The shell installFeatureUI expects, kept as small as possible. */
function createDocument({ hidden = true } = {}) {
  const doc = {
    hidden,
    visibilityState: hidden ? 'hidden' : 'visible',
    activeElement: null,
    createElement: tag => new Element(tag, doc),
    createElementNS: (_ns, tag) => new Element(tag, doc),
    createTextNode: value => ({ textContent: String(value) }),
    listeners: new Map(),
  };
  const body = new Element('body', doc);
  body._root = true;
  doc.body = body;
  doc.activeElement = body;
  doc.getElementById = id => descend(body).find(element => element.id === id) || null;
  doc.querySelector = selector => descend(body).find(element => matches(element, selector)) || null;
  doc.querySelectorAll = selector => descend(body).filter(element => matches(element, selector));
  doc.addEventListener = (type, handler) => {
    if (!doc.listeners.has(type)) doc.listeners.set(type, []);
    doc.listeners.get(type).push(handler);
  };
  doc.removeEventListener = (type, handler) => {
    const handlers = doc.listeners.get(type) || [];
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  };
  doc.pressKey = key => {
    for (const handler of [...(doc.listeners.get('keydown') || [])]) {
      handler({ key, target: doc.activeElement, preventDefault: () => {}, stopPropagation: () => {}, defaultPrevented: false });
    }
  };

  const sidebar = new Element('aside', doc);
  sidebar.className = 'chat-sidebar';
  const sidebarHeader = new Element('header', doc);
  sidebarHeader.className = 'chat-sidebar-header';
  const chats = new Element('div', doc);
  chats.id = 'chats';
  sidebar.append(sidebarHeader, chats);
  const conversation = new Element('section', doc);
  conversation.className = 'conversation';
  const conversationHeader = new Element('header', doc);
  conversationHeader.className = 'conversation-header';
  const conversationActions = new Element('div', doc);
  conversationActions.className = 'conversation-actions';
  conversationHeader.append(conversationActions);
  const composer = new Element('form', doc);
  composer.id = 'composer';
  composer.className = 'composer';
  conversation.append(conversationHeader, composer);
  const popover = new Element('div', doc);
  popover.className = 'rail-popover';
  body.append(sidebar, conversation, popover);
  return doc;
}

/** Recording storage, or one that throws like a blocked third-party frame. */
function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    snapshot: () => new Map(values),
  };
}

function blockedStorage() {
  const reject = () => { throw new Error('SecurityError: almacenamiento bloqueado'); };
  return { getItem: reject, setItem: reject, removeItem: reject };
}

function createWindow({ storage = null, permission = 'granted' } = {}) {
  const notifications = [];
  class FixtureNotification {
    static permission = permission;
    static requests = 0;
    static async requestPermission() {
      FixtureNotification.requests += 1;
      FixtureNotification.permission = 'granted';
      return 'granted';
    }

    constructor(title, options = {}) {
      notifications.push({ title, body: options.body ?? '', silent: options.silent, tag: options.tag ?? '' });
    }
  }
  const view = {
    Notification: FixtureNotification,
    notifications,
    addEventListener: () => {},
    setTimeout,
    clearTimeout,
    innerWidth: 1440,
    innerHeight: 900,
    location: { href: 'https://wa.example.com/' },
  };
  Object.defineProperty(view, 'localStorage', { get: () => storage, configurable: true });
  return view;
}

const flush = () => new Promise(resolve => { setImmediate(resolve); });

function installShell({ storage = memoryStorage(), permission = 'granted', account = ALPHA } = {}) {
  const documentRef = createDocument();
  const windowRef = createWindow({ storage, permission });
  const state = { account, chat: '', chatFilter: 'all' };
  const featureUI = installFeatureUI({ documentRef, windowRef, state, api: async () => ({}), query: path => path });
  return { documentRef, windowRef, featureUI, storage, notifications: windowRef.notifications };
}

/** Dialog as features-ui mounts it: the real openModal body inside the shell. */
function openNotificationDialog(shell) {
  const row = shell.documentRef.getElementById('feature-notifications');
  row.focus();
  row.click();
  return { row, dialog: shell.documentRef.querySelector('.feature-modal') };
}

/* ------------------------------------------------------------------ pure rules */

test('stored preferences keep only the switches the browser can honour', () => {
  assert.deepEqual(normalizeNotificationPreferences({}), {
    messages: { enabled: true, reactions: true, sound: true },
    groups: { enabled: true, reactions: true, sound: true },
    statuses: { enabled: true, sound: true },
    preview: true,
  });
  assert.deepEqual(normalizeNotificationPreferences({
    messages: { enabled: 'false', sound: 0, reactions: 'yes' },
    groups: { enabled: true, sound: null },
    preview: 'nope',
    calls: true,
    statuses: { enabled: false },
  }), {
    messages: { enabled: false, reactions: true, sound: false },
    groups: { enabled: true, reactions: true, sound: true },
    statuses: { enabled: false, sound: true },
    preview: true,
  });
  for (const junk of [null, 'x', 42, [], true]) {
    assert.deepEqual(normalizeNotificationPreferences(junk), {
      messages: { enabled: true, reactions: true, sound: true },
      groups: { enabled: true, reactions: true, sound: true },
      statuses: { enabled: true, sound: true },
      preview: true,
    });
  }
});

test('preferences live under one key per account and broken JSON falls back', () => {
  const storage = memoryStorage({ [alphaKey]: '{broken', [betaKey]: '{"groups":{"enabled":false}}' });
  const store = createNotificationStore(storage);
  assert.deepEqual(store.read(ALPHA), NOTIFICATION_DEFAULTS);
  assert.equal(store.read(BETA).groups.enabled, false);

  const saved = store.setCategory(ALPHA, 'groups', 'enabled', false);
  assert.equal(saved.saved, true);
  assert.equal(storage.snapshot().get(alphaKey), '{"messages":{"enabled":true,"reactions":true,"sound":true},"groups":{"enabled":false,"reactions":true,"sound":true},"statuses":{"enabled":true,"sound":true},"preview":true}');
  assert.equal(storage.snapshot().get(betaKey), '{"groups":{"enabled":false}}', 'saving alpha must not rewrite beta');
});

test('status alerts obey their own switch, sound and preview privacy', () => {
  assert.deepEqual(statusNotificationPayload({}, { name: 'Ana' }), { title: 'Ana', body: 'Nuevo estado', silent: false });
  assert.equal(statusNotificationPayload({ statuses: { enabled: false } }, { name: 'Ana' }), null);
  assert.deepEqual(statusNotificationPayload({ statuses: { sound: false }, preview: false }, { name: 'Ana' }), {
    title: NOTIFICATION_HIDDEN_TITLE, body: 'Nuevo estado disponible', silent: true,
  });
});

test('a blocked storage area still applies the session and never claims it saved', () => {
  const store = createNotificationStore(blockedStorage());
  assert.deepEqual(store.read(ALPHA), NOTIFICATION_DEFAULTS);
  const result = store.setPreview(ALPHA, false);
  assert.equal(result.saved, false, 'storage that throws must not be reported as saved');
  assert.equal(store.read(ALPHA).preview, false, 'the switch still applies while the tab lives');
  assert.equal(createNotificationStore(null).read(ALPHA).preview, true, 'no storage means the documented default');
});

test('category switches silence direct and group chats independently', () => {
  const directOff = { messages: { enabled: false, sound: true }, groups: { enabled: true, sound: true }, preview: true };
  assert.equal(notificationPayload(directOff, { isGroup: false, name: 'Ana', preview: 'Hola' }), null);
  assert.equal(notificationPayload(directOff, { isGroup: true, name: 'Equipo', preview: 'Hola' }).title, 'Equipo');
  const bothOff = { ...directOff, groups: { enabled: false, sound: true } };
  assert.equal(notificationPayload(bothOff, { isGroup: true, name: 'Equipo', preview: 'Hola' }), null);
  assert.equal(notificationPayload({}, { isGroup: false, name: '', preview: '' }).body, NOTIFICATION_EMPTY_BODY);
});

test('the sound switch is per category and maps to the native silent option', () => {
  const mutedDirect = { messages: { enabled: true, sound: false }, groups: { enabled: true, sound: true }, preview: true };
  assert.equal(notificationPayload(mutedDirect, { isGroup: false }).silent, true);
  assert.equal(notificationPayload(mutedDirect, { isGroup: true }).silent, false);
  const mutedGroups = { messages: { enabled: true, sound: true }, groups: { enabled: true, sound: false }, preview: true };
  assert.equal(notificationPayload(mutedGroups, { isGroup: false }).silent, false);
  assert.equal(notificationPayload(mutedGroups, { isGroup: true }).silent, true);
});

test('turning previews off hides the chat name and the message text', () => {
  const noPreview = { messages: { enabled: true, sound: true }, groups: { enabled: true, sound: true }, preview: false };
  for (const isGroup of [false, true]) {
    const payload = notificationPayload(noPreview, { isGroup, name: 'Ana López', preview: 'La clave del wifi es secretita' });
    assert.deepEqual([payload.title, payload.body], [NOTIFICATION_HIDDEN_TITLE, NOTIFICATION_HIDDEN_BODY]);
    assert.equal(`${payload.title} ${payload.body}`.includes('Ana'), false);
    assert.equal(`${payload.title} ${payload.body}`.includes('secretita'), false);
    assert.equal(payload.silent, false, 'previews and sound stay independent');
  }
});

test('reaction alerts use a separate per-category switch and respect preview privacy', () => {
  assert.deepEqual(reactionNotificationPayload({}, { name: 'Ana' }), {
    title: 'Ana', body: NOTIFICATION_REACTION_BODY, silent: false,
  });
  const hidden = reactionNotificationPayload({ preview: false }, { name: 'Ana' });
  assert.deepEqual([hidden.title, hidden.body], [NOTIFICATION_HIDDEN_TITLE, NOTIFICATION_REACTION_HIDDEN_BODY]);
  const directOff = { messages: { enabled: true, reactions: false }, groups: { enabled: true, reactions: true } };
  assert.equal(reactionNotificationPayload(directOff, { name: 'Ana' }), null);
  assert.equal(reactionNotificationPayload(directOff, { isGroup: true, name: 'Equipo' }).title, 'Equipo');
  assert.equal(reactionNotificationPayload({ groups: { enabled: false } }, { isGroup: true }), null);
});

test('the permission state is stated before the user is ever asked', () => {
  assert.match(notificationPermissionLabel('granted'), /activadas/);
  assert.match(notificationPermissionLabel('denied'), /permisos del sitio/);
  assert.match(notificationPermissionLabel('default'), /todav/);
  assert.match(notificationPermissionLabel('granted', false), /no ofrece notificaciones/);
});

/* ------------------------------------------------------------------- dialog UI */

test('the dialog offers only the switches that work and no technical notes', async () => {
  const shell = installShell({ permission: 'default' });
  const { row, dialog } = openNotificationDialog(shell);
  assert.ok(dialog, 'the Notificaciones row must open a modal');
  assert.deepEqual(
    [...dialog.querySelectorAll('input[type="checkbox"]')].map(input => input.id),
    ['notification-preview', 'notification-messages-enabled', 'notification-messages-reactions', 'notification-messages-sound', 'notification-groups-enabled', 'notification-groups-reactions', 'notification-groups-sound', 'notification-statuses-enabled', 'notification-statuses-sound'],
  );
  assert.deepEqual([...dialog.querySelectorAll('.feature-section-title')].map(heading => heading.textContent), ['Mensajes', 'Grupos', 'Estados']);
  assert.deepEqual(dialog.querySelectorAll('.settings-switch').map(row => row.querySelector('strong').textContent), [
    'Mostrar vista previa',
    'Mostrar notificaciones',
    'Mostrar notificaciones de reacciones',
    'Reproducir sonido',
    'Mostrar notificaciones',
    'Mostrar notificaciones de reacciones',
    'Reproducir sonido',
    'Mostrar notificaciones',
    'Reproducir sonido',
  ]);
  const text = dialog.textContent;
  for (const hidden of ['llamada', 'segundo plano', 'silent', 'Firefox', 'pendiente']) {
    assert.equal(text.toLowerCase().includes(hidden), false, `the everyday dialog must not carry "${hidden}" copy`);
  }
  assert.ok(dialog.getElementById('notification-permission-request'), 'an unasked permission needs an explicit activation button');
  assert.match(dialog.getElementById('notification-permission-status').textContent, /todav/);
  assert.equal(shell.windowRef.Notification.requests, 0, 'opening the dialog must not request permission by itself');

  const request = dialog.getElementById('notification-permission-request');
  request.click();
  assert.equal(shell.windowRef.Notification.requests, 1, 'requestPermission runs inside the click task');
  await flush();
  assert.equal(shell.windowRef.Notification.permission, 'granted');
  assert.match(dialog.getElementById('notification-permission-status').textContent, /activadas/);
  assert.equal(dialog.getElementById('notification-permission-request'), null, 'an activated permission keeps a dead button on screen');

  shell.documentRef.pressKey('Escape');
  assert.equal(shell.documentRef.querySelector('.feature-modal'), null, 'Escape closes the dialog');
  assert.equal(shell.documentRef.activeElement, row, 'closing returns focus to the settings row');
});

test('switches persist per account and a rejected write says so without losing the change', () => {
  const storage = memoryStorage({ [betaKey]: '{"messages":{"enabled":false,"sound":true}}' });
  const shell = installShell({ storage });
  const { dialog } = openNotificationDialog(shell);
  dialog.getElementById('notification-groups-enabled').click();
  assert.equal(storage.snapshot().get(alphaKey), '{"messages":{"enabled":true,"reactions":true,"sound":true},"groups":{"enabled":false,"reactions":true,"sound":true},"statuses":{"enabled":true,"sound":true},"preview":true}');
  assert.equal(storage.snapshot().get(betaKey), '{"messages":{"enabled":false,"sound":true}}', 'alpha must not touch the beta key');
  assert.equal(dialog.getElementById('notification-storage-status').hidden, true, 'a successful write shows no warning');

  const blocked = installShell({ storage: blockedStorage() });
  const blockedDialog = openNotificationDialog(blocked).dialog;
  blockedDialog.getElementById('notification-messages-sound').click();
  const notice = blockedDialog.getElementById('notification-storage-status');
  assert.equal(notice.hidden, false, 'blocked storage must be said out loud');
  assert.match(notice.textContent, /no se pueden guardar/i);
  assert.equal(blockedDialog.getElementById('notification-messages-sound').checked, false, 'the switch keeps the chosen value for this session');
});

test('a control left from another account never writes for the new one', () => {
  const documentRef = createDocument();
  const host = documentRef.createElement('div');
  documentRef.body.append(host);
  const storage = memoryStorage();
  const windowRef = createWindow({ storage, permission: 'granted' });
  let account = ALPHA;
  const settings = installNotificationSettings({
    documentRef,
    windowRef,
    storage,
    getAccount: () => account,
    openModal: () => ({ body: host }),
  });
  settings.open();
  const stale = documentRef.getElementById('notification-groups-enabled');
  assert.equal(settings.isOpen(), true);

  account = BETA;
  stale.click();
  assert.equal(stale.checked, true, 'a rejected click snaps back to the stored value');
  assert.deepEqual([...storage.snapshot().keys()], [], 'no account may be written by a control from another one');
  assert.equal(settings.isOpen(), false, 'the dialog is not the new account dialog');

  settings.open();
  assert.equal(documentRef.getElementById('notification-groups-enabled') === stale, false, 'the new account gets fresh controls');
  documentRef.getElementById('notification-groups-enabled').click();
  assert.deepEqual([...storage.snapshot().keys()], [betaKey], 'only the active account is stored');
});

test('reading window.localStorage may throw before any switch is drawn', () => {
  const documentRef = createDocument();
  const host = documentRef.createElement('div');
  documentRef.body.append(host);
  const windowRef = createWindow({ permission: 'default' });
  Object.defineProperty(windowRef, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: almacenamiento bloqueado'); },
  });
  const settings = installNotificationSettings({
    documentRef,
    windowRef,
    getAccount: () => ALPHA,
    openModal: () => ({ body: host }),
    permission: () => 'default',
    requestPermission: async () => 'granted',
  });
  assert.deepEqual(settings.preferences(), NOTIFICATION_DEFAULTS, 'a throwing storage falls back to the documented defaults');
  settings.open();
  assert.equal(documentRef.querySelectorAll('.settings-switch').length, 9);
  documentRef.getElementById('notification-messages-sound').click();
  assert.match(documentRef.getElementById('notification-storage-status').textContent, /no se pueden guardar/i);
  assert.equal(settings.payloadFor({ isGroup: false, name: 'Ana', preview: 'Hola' }).silent, true);
});

/* ------------------------------------------------- chat list notification flow */

function chat(id, name, { isGroup = false, unread = 0, at = '2026-09-20T10:00:00Z', preview = '', muted } = {}) {
  return { id, name, isGroup, unread, timestamp: at, preview, ...(muted === undefined ? {} : { muted }) };
}

function deliver(shell, first, second) {
  shell.featureUI.chatsChanged([first, second]);
  const before = shell.notifications.length;
  shell.featureUI.chatsChanged([
    { ...first, unread: 1, preview: 'Hola directo', timestamp: '2026-09-20T11:00:00Z' },
    { ...second, unread: 1, preview: 'Hola grupo', timestamp: '2026-09-20T11:00:00Z' },
  ]);
  return shell.notifications.slice(before);
}

test('the first snapshot never re-notifies synchronized history', () => {
  const shell = installShell();
  shell.featureUI.chatsChanged([chat('123@c.us', 'Ana'), chat('team@g.us', 'Equipo', { isGroup: true, unread: 4, preview: 'Antiguo' })]);
  assert.deepEqual(shell.notifications, [], 'history already on screen must not produce alerts');
});

test('a genuinely new unread chat notifies, while an older page does not', () => {
  const shell = installShell();
  const baseline = chat('known@c.us', 'Conocido', { at: '2026-09-20T10:00:00Z' });
  shell.featureUI.chatsChanged([baseline]);
  shell.featureUI.chatsChanged([
    baseline,
    chat('older@c.us', 'Histórico', { unread: 2, at: '2026-09-19T10:00:00Z', preview: 'Antes' }),
  ]);
  assert.deepEqual(shell.notifications, [], 'pagination must not alert old unread chats');
  shell.featureUI.chatsChanged([
    baseline,
    chat('older@c.us', 'Histórico', { unread: 2, at: '2026-09-19T10:00:00Z', preview: 'Antes' }),
    chat('new@c.us', 'Nuevo', { unread: 1, at: '2026-09-20T10:01:00Z', preview: 'Hola' }),
  ]);
  assert.deepEqual(shell.notifications.map(item => [item.title, item.body]), [['Nuevo', 'Hola']]);
});

test('an account with an empty first snapshot can notify its first new chat', () => {
  const shell = installShell();
  shell.featureUI.chatsChanged([]);
  assert.deepEqual(shell.notifications, []);
  shell.featureUI.chatsChanged([chat('first@c.us', 'Primero', {
    unread: 1, at: new Date().toISOString(), preview: 'Hola',
  })]);
  assert.deepEqual(shell.notifications.map(item => item.title), ['Primero']);
});

test('direct and group notifications follow their own switch, sound and preview', () => {
  const shell = installShell();
  const first = chat('123@c.us', 'Ana');
  const second = chat('team@g.us', 'Equipo', { isGroup: true });
  const delivered = deliver(shell, first, second);
  assert.deepEqual(delivered.map(item => [item.title, item.body, item.silent]), [['Ana', 'Hola directo', false], ['Equipo', 'Hola grupo', false]]);
  assert.ok(delivered.every(item => item.tag.startsWith('socialmedia-alpha-')), 'each tag stays scoped to the account and chat');

  const dialog = openNotificationDialog(shell).dialog;
  dialog.getElementById('notification-groups-enabled').click();
  dialog.getElementById('notification-messages-sound').click();
  shell.documentRef.pressKey('Escape');
  const afterGroupsOff = deliver(shell, first, second);
  assert.deepEqual(afterGroupsOff.map(item => [item.title, item.silent]), [['Ana', true]], 'groups are suppressed while direct chats keep notifying');
  assert.equal(afterGroupsOff.length, 1);

  const previewOff = openNotificationDialog(shell).dialog;
  previewOff.getElementById('notification-preview').click();
  shell.documentRef.pressKey('Escape');
  assert.deepEqual(deliver(shell, first, second).map(item => [item.title, item.body]), [['SocialMedia', 'Mensaje nuevo']]);

  const directOff = openNotificationDialog(shell).dialog;
  directOff.getElementById('notification-messages-enabled').click();
  shell.documentRef.pressKey('Escape');
  assert.deepEqual(deliver(shell, first, second), [], 'both switches off means silence, including for muted chats');
});

test('muted chats and an account switch keep the notification baseline honest', () => {
  const shell = installShell();
  const direct = chat('123@c.us', 'Ana');
  const mutedGroup = chat('team@g.us', 'Equipo', { isGroup: true, muted: true });
  assert.deepEqual(deliver(shell, direct, mutedGroup).map(item => item.title), ['Ana'], 'a muted group stays silent');

  shell.featureUI.accountChanged(BETA);
  assert.equal(shell.documentRef.querySelector('.feature-modal'), null, 'the dialog cannot follow an account switch');
  shell.featureUI.chatsChanged([chat('beta-direct', 'Bruno', { unread: 7, preview: 'Viejo' })]);
  assert.equal(shell.notifications.filter(item => item.title === 'Bruno').length, 0, 'the new account must not be alerted about its own history');
  shell.featureUI.chatsChanged([chat('beta-direct', 'Bruno', { unread: 8, preview: 'Nuevo', at: '2026-09-20T12:00:00Z' })]);
  assert.deepEqual(shell.notifications.slice(-1).map(item => [item.title, item.body, item.silent]), [['Bruno', 'Nuevo', false]]);

  const dialog = openNotificationDialog({ ...shell, documentRef: shell.documentRef }).dialog;
  assert.equal(dialog.textContent.includes('Equipo'), false);
  dialog.getElementById('notification-groups-enabled').click();
  assert.equal(shell.storage.snapshot().get(betaKey), '{"messages":{"enabled":true,"reactions":true,"sound":true},"groups":{"enabled":false,"reactions":true,"sound":true},"statuses":{"enabled":true,"sound":true},"preview":true}');
  assert.equal(shell.storage.snapshot().has(alphaKey), false, 'beta changes must not create an alpha key');
});

test('reaction hints notify only for a known unmuted chat in the hidden active account', () => {
  const shell = installShell();
  const own = chat('peer@c.us', 'Ana');
  shell.featureUI.chatsChanged([own, chat('muted@g.us', 'Equipo', { isGroup: true, muted: true })]);
  const hint = { account: ALPHA, conversation_id: own.id, wa_message_id: 'target', reason: 'reaction-to-own-message' };
  shell.featureUI.reactionHint(hint);
  assert.deepEqual(shell.notifications.map(item => [item.title, item.body, item.silent]), [['Ana', NOTIFICATION_REACTION_BODY, false]]);
  shell.featureUI.reactionHint({ ...hint, reason: 'reaction' });
  shell.featureUI.reactionHint({ ...hint, account: BETA });
  shell.featureUI.reactionHint({ ...hint, conversation_id: 'unknown' });
  shell.featureUI.reactionHint({ ...hint, conversation_id: 'muted@g.us' });
  assert.equal(shell.notifications.length, 1);

  const dialog = openNotificationDialog(shell).dialog;
  dialog.getElementById('notification-messages-reactions').click();
  shell.documentRef.pressKey('Escape');
  shell.featureUI.reactionHint(hint);
  assert.equal(shell.notifications.length, 1, 'the reaction switch suppresses only reaction alerts');
  shell.featureUI.accountChanged(BETA);
  shell.featureUI.reactionHint(hint);
  assert.equal(shell.notifications.length, 1, 'an old account hint cannot follow the switch');
});

function notificationKeys(storage) {
  return [...storage.snapshot().keys()].filter(key => key.startsWith(NOTIFICATION_STORAGE_PREFIX));
}

test('controls replaced by the permission refresh cannot reach storage afterwards', async () => {
  const shell = installShell({ permission: 'default' });
  const { dialog } = openNotificationDialog(shell);
  const staleSwitch = dialog.getElementById('notification-messages-sound');
  const activation = dialog.getElementById('notification-permission-request');

  activation.click();
  assert.equal(shell.windowRef.Notification.requests, 1, 'the click itself asks for permission');
  await flush();
  assert.equal(staleSwitch.isConnected, false, 'the refresh draws new controls');

  staleSwitch.checked = false;
  staleSwitch.dispatch('change');
  assert.deepEqual(notificationKeys(shell.storage), [], 'a detached switch must not write for anyone');
  assert.equal(dialog.getElementById('notification-messages-sound').checked, true, 'the drawn switch keeps the stored value');

  activation.click();
  await flush();
  assert.equal(shell.windowRef.Notification.requests, 1, 'a detached activation button must not open a second prompt');
  assert.deepEqual(notificationKeys(shell.storage), [], 'granting permission stores no preference');
});

test('an activation button from a closed dialog never asks for permission again', async () => {
  const shell = installShell({ permission: 'default' });
  const { dialog } = openNotificationDialog(shell);
  const activation = dialog.getElementById('notification-permission-request');
  shell.documentRef.pressKey('Escape');
  assert.equal(shell.documentRef.querySelector('.feature-modal'), null);

  activation.click();
  await flush();
  assert.equal(shell.windowRef.Notification.requests, 0, 'closing the dialog removes the right to prompt');
});
