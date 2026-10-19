'use strict';

/*
 * Account-scoped desktop notification preferences.
 *
 * The reference Windows client lists Mensajes, Grupos, Estados and Llamadas and
 * each Messages/Groups subpage offers "Mostrar notificaciones", "Mostrar
 * notificaciones de reacciones" and "Reproducir sonido", with a preview switch,
 * an outgoing sound and background synchronization above them. A browser tab can
 * honour message, group, status and reaction switches, native sound through the `silent`
 * option of the Notification constructor, and preview privacy. Only these are
 * controls here; the rest stays pending in
 * docs/whatsapp-parity-audit.md so the everyday dialog never shows a control
 * that cannot do anything.
 *
 * Preferences never reach the provider. They live in localStorage under one key
 * per account, so an account switch cannot inherit another account's choices,
 * and a blocked storage area only costs persistence, not the current session.
 */

export const NOTIFICATION_STORAGE_PREFIX = 'socialmedia-wa-notifications:';
export const NOTIFICATION_CATEGORY_LABELS = Object.freeze({ messages: 'Mensajes', groups: 'Grupos', statuses: 'Estados' });
export const NOTIFICATION_ROW_LABELS = Object.freeze({
  preview: Object.freeze(['Mostrar vista previa', 'Incluye el nombre del chat y el texto del mensaje en la notificación.']),
  enabled: Object.freeze(['Mostrar notificaciones', 'Avisa cuando llega un mensaje nuevo a este tipo de chat.']),
  statusesEnabled: Object.freeze(['Mostrar notificaciones', 'Avisa cuando otra persona publica un estado nuevo.']),
  reactions: Object.freeze(['Mostrar notificaciones de reacciones', 'Avisa cuando otra persona reacciona a uno de tus mensajes.']),
  sound: Object.freeze(['Reproducir sonido', 'Usa el sonido de aviso del sistema para estas notificaciones.']),
});
/** Content used when previews are off: neither the chat nor the message text. */
export const NOTIFICATION_HIDDEN_TITLE = 'SocialMedia';
export const NOTIFICATION_HIDDEN_BODY = 'Mensaje nuevo';
export const NOTIFICATION_EMPTY_BODY = 'Nuevo mensaje';
export const NOTIFICATION_REACTION_BODY = 'Han reaccionado a tu mensaje';
export const NOTIFICATION_REACTION_HIDDEN_BODY = 'Nueva reacción';
export const NOTIFICATION_STATUS_BODY = 'Nuevo estado';

function text(value) {
  return value == null ? '' : String(value);
}

function switchValue(value, fallback = true) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

export const NOTIFICATION_DEFAULTS = Object.freeze({
  messages: Object.freeze({ enabled: true, reactions: true, sound: true }),
  groups: Object.freeze({ enabled: true, reactions: true, sound: true }),
  statuses: Object.freeze({ enabled: true, sound: true }),
  preview: true,
});

/** Stored JSON is untrusted: only the switches this module can honour survive. */
export function normalizeNotificationPreferences(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const category = name => {
    const raw = source[name] && typeof source[name] === 'object' ? source[name] : {};
    return { enabled: switchValue(raw.enabled, true), ...(name === 'statuses' ? {} : { reactions: switchValue(raw.reactions, true) }), sound: switchValue(raw.sound, true) };
  };
  return { messages: category('messages'), groups: category('groups'), statuses: category('statuses'), preview: switchValue(source.preview, true) };
}

/**
 * Reading `window.localStorage` itself throws a SecurityError when the browser
 * blocks storage, so every access goes through a getter kept under try/catch.
 * `storage` accepts a Storage object, a getter, or nothing at all.
 */
function storageGetter(storage) {
  return () => {
    try {
      if (typeof storage === 'function') return storage() ?? null;
      if (storage) return storage;
      return globalThis.window?.localStorage ?? globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
}

/** One key per account, so switching accounts can never read another choice. */
export function createNotificationStore(storage = null) {
  const cache = new Map();
  const area = storageGetter(storage);
  const key = account => `${NOTIFICATION_STORAGE_PREFIX}${encodeURIComponent(text(account).trim())}`;
  const persist = (id, preferences) => {
    cache.set(id, preferences);
    const target = area();
    if (!target) return { preferences, saved: false };
    try {
      target.setItem(key(id), JSON.stringify(preferences));
      return { preferences, saved: true };
    } catch {
      return { preferences, saved: false };
    }
  };

  return {
    key,
    read(account) {
      const id = text(account).trim();
      if (cache.has(id)) return cache.get(id);
      let stored = null;
      try { stored = area()?.getItem(key(id)) ?? null; } catch { stored = null; }
      let parsed = {};
      try { parsed = JSON.parse(stored || '{}'); } catch { parsed = {}; }
      const preferences = normalizeNotificationPreferences(parsed);
      cache.set(id, preferences);
      return preferences;
    },
    setCategory(account, category, flag, value) {
      if (!NOTIFICATION_CATEGORY_LABELS[category] || !['enabled', 'reactions', 'sound'].includes(flag)) {
        return { preferences: this.read(account), saved: false, ignored: true };
      }
      const current = this.read(account);
      return persist(text(account).trim(), { ...current, [category]: { ...current[category], [flag]: switchValue(value, false) } });
    },
    setPreview(account, value) {
      const current = this.read(account);
      return persist(text(account).trim(), { ...current, preview: switchValue(value, false) });
    },
  };
}

/**
 * Notification content for one chat update, or null when the category is off.
 * `silent` mirrors the category sound switch: the Notifications specification
 * treats `true` as "no sound regardless of the device" and `false` as the normal
 * path, so an enabled switch keeps the system sound. Firefox and Safari ignore
 * `silent` (MDN), which is documented as a limitation instead of simulated.
 */
export function notificationPayload(preferences = {}, { isGroup = false, name = '', preview = '' } = {}) {
  const normalized = normalizeNotificationPreferences(preferences);
  const category = isGroup ? normalized.groups : normalized.messages;
  if (!category.enabled) return null;
  return {
    title: normalized.preview ? text(name).trim() || NOTIFICATION_HIDDEN_TITLE : NOTIFICATION_HIDDEN_TITLE,
    body: normalized.preview ? text(preview).trim() || NOTIFICATION_EMPTY_BODY : NOTIFICATION_HIDDEN_BODY,
    silent: !category.sound,
  };
}

export function reactionNotificationPayload(preferences = {}, { isGroup = false, name = '' } = {}) {
  const normalized = normalizeNotificationPreferences(preferences);
  const category = isGroup ? normalized.groups : normalized.messages;
  if (!category.enabled || !category.reactions) return null;
  return {
    title: normalized.preview ? text(name).trim() || NOTIFICATION_HIDDEN_TITLE : NOTIFICATION_HIDDEN_TITLE,
    body: normalized.preview ? NOTIFICATION_REACTION_BODY : NOTIFICATION_REACTION_HIDDEN_BODY,
    silent: !category.sound,
  };
}

export function statusNotificationPayload(preferences = {}, { name = '' } = {}) {
  const normalized = normalizeNotificationPreferences(preferences);
  if (!normalized.statuses.enabled) return null;
  return {
    title: normalized.preview ? text(name).trim() || NOTIFICATION_HIDDEN_TITLE : NOTIFICATION_HIDDEN_TITLE,
    body: normalized.preview ? NOTIFICATION_STATUS_BODY : 'Nuevo estado disponible',
    silent: !normalized.statuses.sound,
  };
}

export function notificationPermissionLabel(permission = 'default', supported = true) {
  if (!supported) return 'Este navegador no ofrece notificaciones de escritorio.';
  if (permission === 'granted') return 'Las notificaciones están activadas en este navegador.';
  if (permission === 'denied') return 'El navegador bloqueó las notificaciones. Actívalas desde los permisos del sitio.';
  return 'El navegador todavía no permite mostrar notificaciones. Actívalas para recibir avisos.';
}

/**
 * Install the "Notificaciones" dialog inside the feature modal shell owned by
 * `openModal`. The permission request must be invoked from the click task, so
 * `requestPermission` is called before any await in the handler.
 */
export function installNotificationSettings({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  storage = null,
  getAccount,
  openModal,
  permission = () => 'default',
  requestPermission = async () => 'default',
} = {}) {
  if (!documentRef || typeof openModal !== 'function' || typeof getAccount !== 'function') return null;

  const store = createNotificationStore(typeof storage === 'function' ? storage : () => storage ?? windowRef?.localStorage ?? null);
  const supported = () => Boolean(windowRef?.Notification || globalThis.Notification);
  const make = (tag, className = '', value) => {
    const element = documentRef.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = text(value);
    return element;
  };

  let body = null;
  let storageNotice = null;
  let openedFor = '';
  let generation = 0;
  let storageFailure = '';

  function preferences() { return store.read(getAccount()); }

  function payloadFor({ isGroup = false, name = '', preview = '' } = {}) {
    return notificationPayload(preferences(), { isGroup, name, preview });
  }

  function reactionPayloadFor({ isGroup = false, name = '' } = {}) {
    return reactionNotificationPayload(preferences(), { isGroup, name });
  }

  function statusPayloadFor({ name = '' } = {}) {
    return statusNotificationPayload(preferences(), { name });
  }

  function showStorageFailure(saved) {
    storageFailure = saved ? '' : 'No se pueden guardar las preferencias en este navegador; se aplican mientras dure la sesión.';
    if (storageNotice) {
      storageNotice.textContent = storageFailure;
      storageNotice.hidden = !storageFailure;
    }
  }

  function switchRow(name, { title, hint, checked }) {
    const context = { account: openedFor, generation };
    const row = make('label', 'settings-switch');
    const copy = make('span');
    copy.append(make('strong', '', title), make('small', '', hint));
    const input = make('input');
    input.type = 'checkbox';
    input.id = `notification-${name.replace('.', '-')}`;
    input.dataset.notificationSetting = name;
    input.checked = checked === true;
    input.setAttribute('aria-label', title);
    input.addEventListener('change', () => {
      // The element must still be the drawn one: a re-render detaches the previous
      // controls while the dialog body and generation stay the same.
      if (!input.isConnected || context.generation !== generation || context.account !== text(getAccount()) || !body?.isConnected) {
        input.checked = !input.checked;
        return;
      }
      const result = name === 'preview'
        ? store.setPreview(context.account, input.checked)
        : store.setCategory(context.account, name.split('.')[0], name.split('.')[1], input.checked);
      if (result.ignored) { input.checked = !input.checked; return; }
      showStorageFailure(result.saved);
    });
    row.append(copy, input);
    return row;
  }

  function categorySection(category) {
    const section = make('section', 'settings-section');
    const heading = make('h3', 'feature-section-title', NOTIFICATION_CATEGORY_LABELS[category]);
    heading.id = `notification-${category}-title`;
    const current = preferences()[category];
    const enabledLabel = category === 'statuses' ? NOTIFICATION_ROW_LABELS.statusesEnabled : NOTIFICATION_ROW_LABELS.enabled;
    section.append(
      heading,
      switchRow(`${category}.enabled`, { title: enabledLabel[0], hint: enabledLabel[1], checked: current.enabled }),
      ...(category === 'statuses' ? [] : [switchRow(`${category}.reactions`, { title: NOTIFICATION_ROW_LABELS.reactions[0], hint: NOTIFICATION_ROW_LABELS.reactions[1], checked: current.reactions })]),
      switchRow(`${category}.sound`, { title: NOTIFICATION_ROW_LABELS.sound[0], hint: NOTIFICATION_ROW_LABELS.sound[1], checked: current.sound }),
    );
    return section;
  }

  function permissionSection() {
    const section = make('section', 'settings-section');
    const status = make('p', 'feature-muted', notificationPermissionLabel(permission(), supported()));
    status.id = 'notification-permission-status';
    status.setAttribute('role', 'status');
    section.append(status);
    if (supported() && permission() !== 'granted') {
      const request = make('button', 'feature-button subtle', 'Activar notificaciones');
      request.type = 'button';
      request.id = 'notification-permission-request';
      const context = { account: openedFor, generation };
      request.onclick = () => {
        // Refuse a stale control before the prompt: an OS permission dialog cannot
        // be retracted once the tab that asked for it stopped existing.
        if (!request.isConnected || context.generation !== generation || context.account !== text(getAccount())) return;
        // No await before this call: requestPermission() needs the user gesture.
        const result = requestPermission();
        Promise.resolve(result)
          .then(() => {
            if (!request.isConnected || context.generation !== generation || context.account !== text(getAccount()) || !body?.isConnected) return;
            render();
          })
          .catch(() => {});
      };
      section.append(request);
    }
    return section;
  }

  function previewSection() {
    const section = make('section', 'settings-section');
    storageNotice = make('p', 'feature-muted', storageFailure);
    storageNotice.id = 'notification-storage-status';
    storageNotice.setAttribute('role', 'status');
    storageNotice.hidden = !storageFailure;
    section.append(
      switchRow('preview', { title: NOTIFICATION_ROW_LABELS.preview[0], hint: NOTIFICATION_ROW_LABELS.preview[1], checked: preferences().preview }),
      storageNotice,
    );
    return section;
  }

  function render() {
    if (!body?.isConnected) return;
    const active = text(documentRef.activeElement?.dataset?.notificationSetting);
    body.replaceChildren(permissionSection(), previewSection(), categorySection('messages'), categorySection('groups'), categorySection('statuses'));
    if (active) body.querySelector?.(`[data-notification-setting="${active}"]`)?.focus?.();
  }

  function open() {
    const modal = openModal('Notificaciones');
    if (!modal?.body) return null;
    body = modal.body;
    openedFor = text(getAccount());
    generation += 1;
    storageFailure = '';
    render();
    return modal;
  }

  return {
    open,
    preferences,
    payloadFor,
    reactionPayloadFor,
    statusPayloadFor,
    store,
    isOpen: () => Boolean(body?.isConnected) && text(getAccount()) === openedFor,
  };
}
