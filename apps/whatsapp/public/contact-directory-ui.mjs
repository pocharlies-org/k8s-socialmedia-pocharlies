/**
 * Cajón "Nuevo chat" (equivalente al cajón oficial de WhatsApp Web).
 *
 * Busca por nombre o número, recorre los contactos que la cuenta ya tiene
 * sincronizados y ofrece las acciones de creación. Abrir un contacto existente
 * es local: no se envía ningún mensaje. Las limitaciones de sincronización se
 * muestran tal cual salen del servidor.
 */

export const CONTACT_DIRECTORY_LIMIT = 60;
const SEARCH_DEBOUNCE_MS = 250;
const CONTEXT_POLL_MS = 250;

export const CONTACT_DIRECTORY_ACTIONS = Object.freeze([
  { action: 'group', label: 'Nuevo grupo' },
  { action: 'contact', label: 'Nuevo contacto' },
  { action: 'community', label: 'Nueva comunidad' },
]);

const ENTRY_KINDS = new Set(['chat', 'contact', 'private']);

function text(value) {
  return typeof value === 'string' ? value : '';
}

const AVATAR_PATH = /^\/api\/(?:chats\/[^/]+|contacts\/[^/]+)\/avatar$/;

/** Only our own authenticated avatar proxy for the requested account is trusted. */
export function contactAvatarUrl(value, account, baseUrl = 'http://localhost/') {
  const candidate = text(value).trim();
  if (!candidate) return '';
  try {
    const url = new URL(candidate, baseUrl);
    if (url.origin !== new URL(baseUrl, 'http://localhost/').origin) return '';
    if (!AVATAR_PATH.test(url.pathname)) return '';
    if (url.searchParams.get('account') !== text(account)) return '';
    return `${url.pathname}${url.search}`;
  } catch {
    return '';
  }
}

export function normalizeContactEntry(raw, account, baseUrl = 'http://localhost/') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const key = text(raw.key).trim();
  const label = text(raw.label).trim();
  if (!key || !label || !ENTRY_KINDS.has(raw.kind)) return null;
  const chatId = text(raw.chatId).trim();
  const phone = text(raw.phone).trim();
  if (phone && !/^\+[0-9]{6,15}$/.test(phone)) return null;
  return {
    key,
    label,
    sublabel: text(raw.sublabel).trim(),
    kind: raw.kind,
    chatId: chatId || null,
    phone: phone || null,
    avatarUrl: contactAvatarUrl(raw.avatarUrl, account, baseUrl),
    hasChat: raw.hasChat === true,
    archived: raw.archived === true,
    canOpen: raw.canOpen === true && Boolean(chatId),
    canStart: raw.canStart === true && Boolean(phone),
  };
}

export function contactDirectoryUrl({ account, q = '', cursor = null, limit = CONTACT_DIRECTORY_LIMIT }, baseUrl = 'http://localhost/') {
  const params = new URLSearchParams({ account: text(account), limit: String(limit) });
  const query = text(q).trim();
  if (query) params.set('q', query);
  if (cursor) params.set('cursor', String(cursor));
  return `${new URL('/api/contacts', baseUrl).pathname}?${params}`;
}

/** What the row will do, said before the owner presses it. */
export function contactEntryHint(entry, { sendingEnabled = true } = {}) {
  if (!entry) return '';
  if (entry.canOpen) return entry.archived ? 'Abre un chat archivado' : 'Abre el chat existente';
  if (entry.canStart) return sendingEnabled ? 'Empieza un chat sin enviar nada' : 'Envío desactivado en el servidor';
  return 'Sin número sincronizado';
}

export function contactEntryDisabled(entry, { sendingEnabled = true } = {}) {
  if (!entry) return true;
  return !(entry.canOpen || (entry.canStart && sendingEnabled === true));
}

function count(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString('es-ES') : '0';
}

/** Status line: what was found, out of what, and from when. */
export function directoryStatusLabel(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const sync = payload.sync && typeof payload.sync === 'object' ? payload.sync : {};
  const identities = count(sync.identities);
  const latest = text(sync.latestSyncAt);
  const when = latest ? new Date(latest) : null;
  const stamp = when && !Number.isNaN(when.getTime())
    ? ` · sincronizado el ${new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(when)}`
    : '';
  if (text(payload.query).trim()) return `${count(payload.total)} coincidencias entre ${identities} identidades sincronizadas${stamp}.`;
  return `${identities} identidades sincronizadas en esta cuenta${stamp}.`;
}

/**
 * The official drawer can open a chat with a number the account has never seen.
 * Only a real phone shape qualifies: a LID or a JID contains letters or `@` and
 * must not be dialled as if it were a number.
 */
export function typedPhoneTarget(value) {
  const raw = text(value).trim().replace(/\s+/g, ' ');
  if (!raw || raw.includes('@') || /[^+\d().\- ]/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return null;
  // Nine digits without a plus is a national number: the connector resolves it
  // with the account's own country code, so the `+` must not be invented here.
  const national = !raw.startsWith('+') && digits.length === 9;
  const display = national ? raw : `+${digits}`;
  return { key: `typed:${digits}`, digits, display, phone: national ? raw : `+${digits}` };
}

export function createContactDirectoryClient({ api, getAccount, limit = CONTACT_DIRECTORY_LIMIT, baseUrl = () => 'http://localhost/' } = {}) {
  let generation = 0;
  const isCurrent = token => token.generation === generation && token.account === getAccount();

  async function page({ q = '', cursor = null } = {}) {
    const token = { account: text(getAccount()), generation };
    if (!token.account) return null;
    const result = await api(contactDirectoryUrl({ account: token.account, q, cursor, limit }, baseUrl()));
    if (!isCurrent(token)) return null;
    if (result?.account !== token.account || !Array.isArray(result.contacts)) {
      throw new Error('Respuesta del directorio de contactos no válida.');
    }
    const entries = result.contacts.map(entry => normalizeContactEntry(entry, token.account, baseUrl())).filter(Boolean);
    return {
      entries,
      query: text(result.query),
      total: Number(result.total || 0),
      hasMore: result.hasMore === true,
      nextCursor: typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null,
      sendingEnabled: result.sendingEnabled === true,
      sync: result.sync && typeof result.sync === 'object' ? result.sync : {},
    };
  }

  return {
    page,
    isCurrent,
    invalidate() { generation += 1; },
  };
}

export function installContactDirectoryUI({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  api,
  getAccount,
  getEpoch = () => 0,
  onOpenChat = async () => {},
  onStartChat = async () => {},
  onAction = () => {},
  onOpen = () => {},
  baseUrl = () => `${windowRef?.location?.origin || 'http://localhost/'}/`,
} = {}) {
  if (!documentRef || typeof api !== 'function' || typeof getAccount !== 'function') return null;
  const node = (tag, className = '', value = '') => {
    const element = documentRef.createElement(tag);
    if (className) element.className = className;
    if (value !== '') element.textContent = value;
    return element;
  };
  const schedule = (callback, delay) => {
    if (typeof windowRef?.setTimeout === 'function') return windowRef.setTimeout(callback, delay);
    return setTimeout(callback, delay);
  };
  const clearScheduled = handle => {
    if (handle == null) return;
    if (typeof windowRef?.clearTimeout === 'function') windowRef.clearTimeout(handle);
    else clearTimeout(handle);
  };
  const client = createContactDirectoryClient({ api, getAccount, baseUrl });
  const state = {
    root: null,
    panel: null,
    query: null,
    status: null,
    notices: null,
    list: null,
    more: null,
    opener: null,
    cursor: null,
    loadedAccount: '',
    epoch: 0,
    request: 0,
    pending: null,
    debounce: null,
    poll: null,
    sendingEnabled: true,
    closed: true,
    lastError: '',
    typed: null,
  };

  function destroy() {
    state.root?.remove();
    state.root = null;
    state.closed = true;
  }

  // Escape closes the drawer from anywhere, the way the official client and the
  // other panels of this app do. The search field stops the event first, so
  // there it only clears what was typed.
  function onDocumentKey(event) {
    if (state.closed || event.key !== 'Escape') return;
    event.preventDefault();
    close();
  }

  function setStatus(message, kind = 'info') {
    if (!state.status) return;
    state.status.textContent = text(message);
    state.status.dataset.kind = kind === 'error' ? 'error' : 'info';
    // A failed page is worth one tap to try again: without it the only way
    // back is to close the drawer and lose the search that was typed.
    if (state.retry) state.retry.hidden = kind !== 'error';
  }

  function entryRow(entry) {
    const row = documentRef.createElement('button');
    row.type = 'button';
    row.className = 'contact-directory-entry';
    row.dataset.key = entry.key;
    row.dataset.kind = entry.kind;
    const avatar = node('span', 'contact-directory-avatar');
    avatar.setAttribute('aria-hidden', 'true');
    if (entry.avatarUrl) {
      const image = documentRef.createElement('img');
      image.src = entry.avatarUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => image.remove());
      avatar.append(image);
    }
    avatar.append(node('span', 'contact-directory-initial', [...entry.label.trim()][0]?.toUpperCase() || '?'));
    const copy = node('span', 'contact-directory-copy');
    copy.append(node('strong', '', entry.label));
    const detail = [entry.sublabel, contactEntryHint(entry, { sendingEnabled: state.sendingEnabled })].filter(Boolean).join(' · ');
    copy.append(node('span', 'contact-directory-detail', detail));
    row.append(avatar, copy);
    row.disabled = contactEntryDisabled(entry, { sendingEnabled: state.sendingEnabled });
    row.onclick = async () => {
      if (row.disabled || state.pending) return;
      state.pending = row;
      row.classList.add('is-busy');
      try {
        if (entry.canOpen) await onOpenChat(entry);
        else if (entry.canStart) await onStartChat(entry);
      } finally {
        row.classList.remove('is-busy');
        state.pending = null;
      }
    };
    return row;
  }

  function typedEntry(value) {
    const target = typedPhoneTarget(value);
    if (!target) return null;
    if ((state.entries || []).some(item => item.phone && item.phone.replace(/\D/g, '') === target.digits)) return null;
    return {
      key: target.key,
      label: `Abrir chat con ${target.display}`,
      sublabel: '',
      kind: 'typed',
      chatId: null,
      phone: target.phone,
      avatarUrl: '',
      hasChat: false,
      archived: false,
      canOpen: false,
      canStart: true,
    };
  }

  // The row lives above the results and says what it will dial, so a number
  // that is not in the directory can still start a chat without creating a
  // contact first.
  function syncTypedRow() {
    if (!state.list) return;
    state.root?.querySelector('.contact-directory-typed')?.remove();
    state.typed = null;
    const entry = typedEntry(state.queryInput);
    if (!entry) return;
    const row = entryRow(entry);
    row.classList.add('contact-directory-typed');
    row.dataset.kind = 'typed';
    state.list.prepend(row);
    state.typed = row;
  }

  function renderEntries(entries, { replace = false } = {}) {
    if (!state.list) return;
    if (replace) {
      state.list.replaceChildren();
      state.entries = entries;
    } else {
      state.entries = [...(state.entries || []), ...entries];
    }
    for (const entry of entries) state.list.append(entryRow(entry));
    state.more.hidden = !state.nextCursor;
    if (!state.entries.length) {
      state.list.append(node('p', 'contact-directory-empty', text(state.loadedQuery).trim()
        ? 'Ningún contacto sincronizado coincide con esta búsqueda.'
        : 'Todavía no hay contactos sincronizados en esta cuenta.'));
    }
  }

  function loadNext({ replace = false } = {}) {
    const requestId = ++state.request;
    const cursor = replace ? null : state.nextCursor;
    const query = state.queryInput;
    state.panel?.setAttribute('aria-busy', 'true');
    if (replace) setStatus('');
    return client.page({ q: query, cursor })
      .then(page => {
        if (!page || requestId !== state.request || state.closed) return;
        state.lastError = '';
        state.nextCursor = page.nextCursor;
        state.sendingEnabled = page.sendingEnabled;
        state.loadedQuery = page.query;
        if (replace) renderEntries(page.entries, { replace: true });
        else {
          const seen = new Set((state.entries || []).map(item => item.key));
          const fresh = page.entries.filter(entry => !seen.has(entry.key));
          for (const entry of fresh) state.list.append(entryRow(entry));
          state.entries = [...(state.entries || []), ...fresh];
          state.more.hidden = !state.nextCursor;
        }
        setStatus(directoryStatusLabel(page));
        syncTypedRow();
        if (state.notices) {
          const notices = Array.isArray(page.sync.notices) ? page.sync.notices.filter(item => text(item)) : [];
          state.notices.replaceChildren();
          for (const notice of notices) state.notices.append(node('li', '', notice));
          state.notices.hidden = !notices.length;
        }
      })
      .catch(error => {
        if (requestId !== state.request || state.closed) return;
        state.lastError = error?.message || 'No se pudo cargar el directorio.';
        syncTypedRow();
        setStatus(state.lastError, 'error');
        state.more.hidden = true;
      })
      .finally(() => {
        if (!state.closed) state.panel?.setAttribute('aria-busy', 'false');
      });
  }

  function search(value) {
    state.queryInput = text(value);
    clearScheduled(state.debounce);
    state.debounce = schedule(() => {
      state.entries = [];
      syncTypedRow();
      void loadNext({ replace: true });
    }, SEARCH_DEBOUNCE_MS);
  }

  function close({ restoreFocus = true } = {}) {
    if (state.closed) return;
    state.closed = true;
    clearScheduled(state.debounce);
    if (typeof windowRef?.clearInterval === 'function') windowRef.clearInterval(state.poll);
    else clearInterval(state.poll);
    documentRef.removeEventListener?.('keydown', onDocumentKey);
    client.invalidate();
    destroy();
    if (restoreFocus && state.opener?.isConnected !== false) state.opener.focus?.();
  }

  function open({ opener = null } = {}) {
    if (!state.closed) close({ restoreFocus: false });
    const overlay = node('div', 'contact-directory-overlay');
    overlay.setAttribute('role', 'presentation');
    const panel = node('aside', 'contact-directory-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'contact-directory-title');
    panel.setAttribute('aria-busy', 'true');

    const header = node('header', 'contact-directory-header');
    const closeRow = node('div', 'contact-directory-heading-row');
    const closeButton = documentRef.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'contact-directory-close';
    closeButton.setAttribute('aria-label', 'Cerrar Nuevo chat');
    closeButton.textContent = '×';
    const title = node('h2', 'contact-directory-title', 'Nuevo chat');
    title.id = 'contact-directory-title';
    closeRow.append(closeButton, title);
    const searchRow = node('div', 'contact-directory-search');
    const searchLabel = node('span', 'contact-directory-search-label', 'Buscar nombre o número');
    const input = documentRef.createElement('input');
    input.type = 'search';
    input.id = 'contact-directory-query';
    input.autocomplete = 'off';
    input.placeholder = 'Buscar nombre o número';
    input.setAttribute('aria-label', 'Buscar por nombre o número');
    searchRow.append(searchLabel, input);
    header.append(closeRow, searchRow);

    const actions = node('nav', 'contact-directory-actions');
    actions.setAttribute('aria-label', 'Crear');
    for (const item of CONTACT_DIRECTORY_ACTIONS) {
      const row = documentRef.createElement('button');
      row.type = 'button';
      row.className = 'contact-directory-action';
      row.dataset.action = item.action;
      const icon = node('span', 'contact-directory-action-icon', '');
      icon.setAttribute('aria-hidden', 'true');
      row.append(icon, node('span', 'contact-directory-action-label', item.label));
      row.onclick = () => { onAction(item.action); };
      actions.append(row);
    }

    const status = node('p', 'contact-directory-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const retry = documentRef.createElement('button');
    retry.type = 'button';
    retry.className = 'contact-directory-retry';
    retry.textContent = 'Reintentar';
    retry.hidden = true;
    retry.onclick = () => { void loadNext({ replace: true }); };
    const notices = node('ul', 'contact-directory-notices');
    notices.hidden = true;
    const list = node('div', 'contact-directory-list');
    const more = documentRef.createElement('button');
    more.type = 'button';
    more.className = 'contact-directory-more';
    more.textContent = 'Mostrar más contactos';
    more.hidden = true;
    more.onclick = () => { void loadNext(); };

    panel.append(header, actions, status, retry, notices, list, more);
    overlay.append(panel);
    documentRef.body.append(overlay);

    state.root = overlay;
    state.panel = panel;
    state.queryInput = '';
    state.entries = [];
    state.nextCursor = null;
    state.list = list;
    state.status = status;
    state.retry = retry;
    state.notices = notices;
    state.more = more;
    state.opener = opener;
    state.closed = false;
    state.loadedQuery = '';

    closeButton.onclick = () => close();
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll('button:not([disabled]), input:not([disabled])')]
        .filter(element => !element.closest('[hidden]'));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first) return;
      if (event.shiftKey && documentRef.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && documentRef.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    input.addEventListener('input', () => search(input.value));
    input.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (input.value) { input.value = ''; search(''); return; }
      close();
    });

    state.epoch = getEpoch();
    const startPoll = typeof windowRef?.setInterval === 'function' ? windowRef.setInterval : setInterval;
    state.poll = startPoll(() => {
      if (state.closed) return;
      if (getEpoch() !== state.epoch) { state.epoch = getEpoch(); state.entries = []; void loadNext({ replace: true }); }
    }, CONTEXT_POLL_MS);
    documentRef.addEventListener('keydown', onDocumentKey);

    void loadNext({ replace: true });
    // The panel is already visible and focus has not moved yet: same contract as the other rail panels.
    onOpen();
    queueMicrotask(() => input.focus?.());
  }

  return {
    open,
    close,
    isOpen: () => !state.closed,
    accountChanged: () => { state.entries = []; void loadNext({ replace: true }); },
  };
}
