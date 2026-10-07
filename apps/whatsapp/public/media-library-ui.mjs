/**
 * Panel global "Contenido multimedia": archivos, documentos y enlaces de todos
 * los chats. La descarga requiere una selección explícita del usuario.
 */

export const MEDIA_LIBRARY_LIMIT = 50;

export const MEDIA_LIBRARY_TABS = Object.freeze([
  { kind: 'media', label: 'Archivos multimedia' },
  { kind: 'documents', label: 'Documentos' },
  { kind: 'links', label: 'Enlaces' },
]);

const ITEM_KINDS = new Set(['image', 'video', 'audio', 'document', 'link']);
const TAB_LABELS = new Map(MEDIA_LIBRARY_TABS.map(tab => [tab.kind, tab.label]));
const SENDERS = Object.freeze([['all', 'Todos'], ['me', 'Tú'], ['others', 'Otras personas']]);
const ORDERS = Object.freeze([['newest', 'Más recientes'], ['oldest', 'Más antiguos'], ['longest', 'Mayor duración']]);
const EMPTY_TEXT = Object.freeze({
  media: 'Todavía no hay archivos multimedia.',
  documents: 'Todavía no hay documentos.',
  links: 'Todavía no hay enlaces.',
});
const KIND_ICON = Object.freeze({
  image: ['M4.5 6.5v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-11a2 2 0 0 0-2-2h-11a2 2 0 0 0-2 2Z', 'm6 16 4-4.5 3 3 2.5-2.5L18 16'],
  video: ['M7.5 6.5v11l9-5.5Z'],
  audio: ['M12 4.5a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0V7A2.5 2.5 0 0 1 12 4.5Z', 'M6.5 11a5.5 5.5 0 0 0 11 0', 'M12 16.5v3M8.5 19.5h7'],
  document: ['M7 4.5h6l4 4v11H7Z', 'M13 4.5v4h4'],
  link: ['m9.5 14.5 5-5', 'M11 8.5 9.6 9.9a3.3 3.3 0 0 0 4.6 4.6l1.4-1.4', 'M13 15.5l1.4-1.4a3.3 3.3 0 0 0-4.6-4.6L8.4 11'],
});
const KIND_LABEL = Object.freeze({ image: 'Imagen', video: 'Vídeo', audio: 'Audio', document: 'Documento', link: 'Enlace' });

function text(value) { return typeof value === 'string' ? value : ''; }

const MEDIA_PATH = /^\/api\/media\/(?!thumb\/|link-thumb\/)[^/?#]+$/;

/** Own binary route only: same origin, /api/media/<id>, and the panel's own account. */
export function mediaAssetUrl(value, baseUrl = 'http://localhost/', account = '') {
  const candidate = text(value).trim();
  if (!candidate) return '';
  try {
    const url = new URL(candidate, baseUrl);
    if (url.origin !== new URL(baseUrl, 'http://localhost/').origin) return '';
    if (!MEDIA_PATH.test(url.pathname)) return '';
    if (account && url.searchParams.get('account') !== account) return '';
    return `${url.pathname}${url.search}`;
  } catch { return ''; }
}

/** Absolute http/https links only, without the punctuation a chat appends. */
export function webLinkUrl(value) {
  const candidate = text(value).trim().replace(/[),.!?;:]+$/, '');
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

export function normalizeMediaLibraryItem(raw, baseUrl = 'http://localhost/', account = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !ITEM_KINDS.has(raw.kind)) return null;
  const chatId = text(raw.chatId).trim();
  if (!chatId) return null;
  const links = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw.links) ? raw.links : []) {
    const url = webLinkUrl(entry?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ url, title: text(entry?.title).trim() });
  }
  if (raw.kind === 'link' && !links.length) {
    const single = webLinkUrl(raw.url);
    if (single) links.push({ url: single, title: '' });
  }
  const timestamp = text(raw.timestamp);
  return {
    id: text(raw.id) || `${chatId}:${text(raw.messageId)}`,
    kind: raw.kind,
    chatId,
    chatName: text(raw.chatName).trim() || chatId,
    messageId: text(raw.messageId),
    timestamp: Number.isFinite(new Date(timestamp).getTime()) ? timestamp : '',
    fromMe: raw.fromMe === true,
    name: text(raw.name).trim(),
    mimeType: text(raw.mimeType).trim(),
    durationSeconds: Number.isSafeInteger(raw.durationSeconds) && raw.durationSeconds > 0 ? raw.durationSeconds : null,
    text: text(raw.text),
    url: raw.kind === 'link' ? links[0]?.url || '' : mediaAssetUrl(raw.url, baseUrl, account),
    links,
  };
}

export function uniqueMediaMessages(items) {
  const messages = new Map();
  for (const item of items) {
    if (!item.chatId || !item.messageId) continue;
    messages.set(JSON.stringify([item.chatId, item.messageId]), { chat: item.chatId, messageId: item.messageId });
  }
  return [...messages.values()];
}

export function createMediaLibraryClient({ api, getAccount, baseUrl = () => 'http://localhost/' } = {}) {
  let generation = 0;
  const isCurrent = token => token.generation === generation && token.account === getAccount();

  async function page({ kind = 'media', sender = 'all', order = 'newest', q = '', cursor = null } = {}) {
    const token = { account: getAccount(), generation };
    if (!token.account) return null;
    const params = new URLSearchParams({ account: token.account, kind, sender, order, limit: String(MEDIA_LIBRARY_LIMIT) });
    if (text(q).trim()) params.set('q', text(q).trim());
    if (cursor) params.set('cursor', String(cursor));
    const result = await api(`/api/media-library?${params}`);
    if (!isCurrent(token)) return null;
    if (result?.account !== token.account || !Array.isArray(result.items)) throw new Error('Respuesta de la biblioteca multimedia no válida.');
    const rawCursor = result.nextCursor;
    return {
      items: result.items.map(item => normalizeMediaLibraryItem(item, baseUrl(), token.account)).filter(Boolean),
      nextCursor: typeof rawCursor === 'string' ? rawCursor || null
        : typeof rawCursor === 'number' && Number.isFinite(rawCursor) ? String(rawCursor) : null,
    };
  }

  return {
    page,
    isCurrent,
    scope: () => ({ account: getAccount(), generation }),
    invalidate() { generation += 1; },
  };
}

export function installMediaLibraryUI({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  api,
  getAccount,
  getChats = () => [],
  selectChat = () => {},
  onOpen = () => {},
} = {}) {
  if (!documentRef?.body || typeof api !== 'function' || typeof getAccount !== 'function') return null;
  const rail = documentRef.querySelector('.rail-bottom');
  if (!rail) return null;

  const baseUrl = () => windowRef?.location?.href || 'http://localhost/';
  const client = createMediaLibraryClient({ api, getAccount, baseUrl });
  const make = (tag, className = '', value) => {
    const element = documentRef.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  };
  const control = (className = '', value) => { const element = make('button', className, value); element.type = 'button'; return element; };
  const icon = paths => {
    const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const path = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  };
  const glyphFor = kind => {
    const glyph = make('span', 'media-library-glyph');
    glyph.append(icon(KIND_ICON[kind] || KIND_ICON.document));
    return glyph;
  };

  const entry = control('media-library-rail rail-icon');
  entry.id = 'media-library-toggle';
  entry.title = 'Contenido multimedia';
  entry.setAttribute('aria-label', 'Contenido multimedia');
  entry.setAttribute('aria-controls', 'media-library-panel');
  entry.setAttribute('aria-expanded', 'false');
  entry.append(icon(['M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v9A2.5 2.5 0 0 1 17.5 18h-11A2.5 2.5 0 0 1 4 15.5Z',
    'M4 19.5A2.5 2.5 0 0 0 6.5 22h11', 'M9.5 13.5 12 10l4 5M15 8.5h.01']));
  rail.prepend(entry);

  const overlay = make('div', 'media-library-overlay');
  overlay.hidden = true;
  const panel = make('section', 'media-library-modal');
  panel.id = 'media-library-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Contenido multimedia');
  const header = make('header', 'media-library-header');
  const headerTop = make('div', 'media-library-header-top');
  const closeButton = control('media-library-close');
  closeButton.setAttribute('aria-label', 'Cerrar contenido multimedia');
  closeButton.append(icon(['m6 6 12 12M18 6 6 18']));
  const title = make('h2', 'media-library-title', 'Contenido multimedia');
  const selectButton = control('media-library-select-toggle', 'Seleccionar');
  headerTop.append(title, selectButton, closeButton);
  const headerTabs = make('div', 'media-library-header-tabs');
  header.append(headerTop, headerTabs);

  const controls = make('div', 'media-library-controls');
  const tabs = make('nav', 'media-library-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Tipo de contenido');
  const tabButtons = MEDIA_LIBRARY_TABS.map(tab => {
    const tabButton = control('media-library-tab', tab.label);
    tabButton.dataset.kind = tab.kind;
    tabButton.setAttribute('role', 'tab');
    tabButton.setAttribute('aria-controls', 'media-library-list');
    tabButton.setAttribute('aria-selected', 'false');
    return tabButton;
  });
  tabs.append(...tabButtons);
  const searchToggle = control('media-library-search-toggle');
  searchToggle.setAttribute('aria-label', 'Buscar');
  searchToggle.append(icon(['m20 20-4.2-4.2', 'M10.8 17a6.2 6.2 0 1 0 0-12.4 6.2 6.2 0 0 0 0 12.4Z']));
  const search = make('div', 'media-library-search');
  search.hidden = true;
  const searchClose = control('media-library-search-close');
  searchClose.setAttribute('aria-label', 'Cerrar búsqueda');
  searchClose.append(icon(['m15 5-7 7 7 7', 'M8 12h12']));
  const searchIcon = make('span', 'search-icon');
  searchIcon.setAttribute('aria-hidden', 'true');
  const searchInput = make('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Buscar por remitente o comentario';
  searchInput.setAttribute('aria-label', 'Buscar contenido multimedia');
  search.append(searchClose, searchIcon, searchInput);
  const select = (label, options) => {
    const wrapper = make('label', 'media-library-filter');
    wrapper.append(make('span', 'media-library-filter-label', label));
    const input = documentRef.createElement('select');
    for (const [value, optionLabel] of options) {
      const option = documentRef.createElement('option');
      option.value = value;
      option.textContent = optionLabel;
      input.append(option);
    }
    wrapper.append(input);
    return { wrapper, input };
  };
  const senderFilter = select('Filtrar por autor', SENDERS);
  const orderFilter = select('Ordenar', ORDERS);
  controls.append(senderFilter.wrapper, orderFilter.wrapper);
  headerTabs.append(tabs, searchToggle, search);

  const selectionBar = make('div', 'media-library-selection-bar');
  selectionBar.hidden = true;
  const selectionCount = make('span', 'media-library-selection-count');
  const deleteButton = control('media-library-selection-action is-subtle', 'Eliminar');
  const starButton = control('media-library-selection-action is-subtle', 'Destacar');
  const downloadButton = control('media-library-selection-action', 'Descargar');
  const forwardButton = control('media-library-selection-action is-subtle', 'Reenviar mensajes');
  selectionBar.append(selectionCount, deleteButton, starButton, downloadButton, forwardButton);

  const status = make('p', 'media-library-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const retry = control('media-library-retry', 'Reintentar');
  retry.hidden = true;
  const scroll = make('div', 'media-library-scroll');
  const list = make('div', 'media-library-grid');
  list.id = 'media-library-list';
  list.setAttribute('role', 'tabpanel');
  const more = control('media-library-more', 'Cargar más');
  more.hidden = true;
  scroll.append(list, more);

  const preview = make('div', 'media-library-preview');
  preview.hidden = true;
  const previewHeader = make('header', 'media-library-preview-header');
  const previewTitle = make('span', 'media-library-preview-title');
  const previewClose = control('media-library-close is-overlay');
  previewClose.setAttribute('aria-label', 'Cerrar vista previa');
  previewClose.append(icon(['m6 6 12 12M18 6 6 18']));
  previewHeader.append(previewTitle, previewClose);
  const previewBody = make('div', 'media-library-preview-body');
  const previewChat = control('media-library-preview-chat', 'Abrir chat de origen');
  preview.append(previewHeader, previewBody, previewChat);
  const actionShade = make('div', 'media-library-action-shade');
  actionShade.hidden = true;
  const actionDialog = make('section', 'media-library-action-dialog');
  actionDialog.setAttribute('role', 'dialog');
  actionDialog.setAttribute('aria-modal', 'true');
  actionShade.append(actionDialog);
  panel.append(header, controls, selectionBar, status, retry, scroll, preview, actionShade);
  overlay.append(panel);
  documentRef.body.append(overlay);

  let tab = 'media';
  let items = [];
  let nextCursor = null;
  let loading = false;
  let failure = '';
  let notice = '';
  let loadedSignature = '';
  let opener = null;
  let searchTimer = null;
  let requestSeq = 0;
  let selecting = false;
  let searching = false;
  let acting = false;
  let actionSeq = 0;
  let actionError = false;
  const selected = new Map();

  const queryKind = () => searching && searchInput.value.trim() ? 'all' : tab;
  const signature = () => `${getAccount()}|${queryKind()}|${tab}|${senderFilter.input.value}|${orderFilter.input.value}|${searchInput.value.trim()}`;
  const requested = () => ({ kind: queryKind(), sender: senderFilter.input.value, order: orderFilter.input.value, q: searchInput.value.trim() });
  const formatDate = value => value ? new Date(value).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const formatDuration = value => value ? `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` : '';
  const titleFor = item => item.name || item.text.trim() || (item.kind === 'link' ? item.links[0]?.title || item.links[0]?.url : '') || KIND_LABEL[item.kind];

  function setStatus(message, kind = '') {
    status.textContent = message;
    status.dataset.kind = kind;
    retry.hidden = kind !== 'error';
  }

  function render() {
    const durationOption = orderFilter.input.querySelector('option[value="longest"]');
    durationOption.hidden = queryKind() !== 'media' && queryKind() !== 'all';
    durationOption.disabled = durationOption.hidden;
    for (const tabButton of tabButtons) {
      const active = tabButton.dataset.kind === tab;
      tabButton.classList.toggle('is-active', active);
      tabButton.setAttribute('aria-selected', String(active));
      tabButton.tabIndex = active ? 0 : -1;
    }
    tabs.hidden = searching;
    searchToggle.hidden = searching;
    search.hidden = !searching;
    headerTabs.classList.toggle('is-searching', searching);
    list.setAttribute('aria-label', queryKind() === 'all' ? 'Resultados de búsqueda' : TAB_LABELS.get(tab) || 'Contenido multimedia');
    list.dataset.kind = queryKind();
    const cards = items.map(card);
    list.replaceChildren(...cards);
    selectButton.textContent = selecting ? 'Cancelar' : 'Seleccionar';
    selectionBar.hidden = !selecting;
    selectionCount.textContent = `${selected.size} seleccionado${selected.size === 1 ? '' : 's'}`;
    const chosen = [...selected.values()];
    for (const button of [deleteButton, starButton, forwardButton]) {
      button.disabled = !selected.size || acting || chosen.some(item => !item.chatId || !item.messageId);
    }
    downloadButton.disabled = !selected.size || acting || chosen.some(item => !item.url || item.kind === 'link');
    selectButton.disabled = acting;
    if (loading) setStatus('Cargando contenido…', 'loading');
    else if (failure) setStatus(failure, 'error');
    else if (notice) setStatus(notice, actionError ? 'error-action' : 'notice');
    else if (loadedSignature === signature()) setStatus(cards.length ? '' : (queryKind() === 'all' ? 'No hay resultados.' : EMPTY_TEXT[tab] || 'Sin resultados.'), cards.length ? '' : 'empty');
    else setStatus('');
    more.hidden = !nextCursor || Boolean(failure);
    more.disabled = loading || acting;
    panel.setAttribute('aria-busy', String(loading || acting));
  }

  function openPreview(item) {
    if (!item.url) return;
    previewTitle.textContent = titleFor(item);
    const media = item.kind === 'audio' ? make('audio') : item.kind === 'video' ? make('video') : make('img');
    if (item.kind === 'image') media.alt = titleFor(item);
    else { media.controls = true; media.preload = 'none'; }
    media.src = item.url;
    previewBody.replaceChildren(media);
    previewChat.hidden = false;
    previewChat.onclick = () => { closePreview(); openChat(item); };
    preview.hidden = false;
    previewClose.focus();
  }
  const closePreview = () => { preview.hidden = true; previewBody.replaceChildren(); };
  const hidePreview = restoreFocus => {
    closePreview();
    if (restoreFocus) closeButton.focus();
  };

  function openChat(item) {
    selectChat({ id: item.chatId, name: item.chatName, messageId: item.messageId });
    close();
  }

  function card(item) {
    const element = make('article', 'media-library-card');
    element.dataset.kind = item.kind;
    element.dataset.id = item.id;
    if (item.kind === 'link') {
      const anchors = make('div', 'media-library-links');
      const primary = item.links[0];
      if (primary) {
        const link = make('a', 'media-library-link', primary.title || primary.url);
        link.href = primary.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        anchors.append(link);
      }
      for (const extra of item.links.slice(1)) {
        const link = make('a', 'media-library-link secondary', extra.title || extra.url);
        link.href = extra.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        anchors.append(link);
      }
      if (!anchors.childNodes.length) anchors.append(make('p', 'media-library-unavailable', 'Enlace no disponible'));
      element.append(anchors);
    } else {
      const previewable = Boolean(item.url) && item.kind !== 'document';
      const tile = previewable ? control('media-library-tile') : make('div', 'media-library-tile is-static');
      if (item.kind === 'image' && item.url) {
        const image = make('img');
        image.src = item.url;
        image.alt = titleFor(item);
        image.loading = 'lazy';
        image.decoding = 'async';
        image.onerror = () => { image.remove(); tile.append(glyphFor('image')); };
        tile.append(image);
      } else {
        tile.append(glyphFor(item.kind));
        if (item.kind === 'video' || item.kind === 'audio') tile.append(make('span', 'media-library-kind', KIND_LABEL[item.kind]));
      }
      if (previewable) {
        tile.setAttribute('aria-label', `Ver ${titleFor(item)}`);
        tile.onclick = () => openPreview(item);
      } else if (!item.url) tile.append(make('span', 'media-library-unavailable', 'Aún no disponible'));
      element.append(tile);
    }
    const copy = make('div', 'media-library-copy');
    copy.append(make('strong', '', titleFor(item)));
    const meta = [formatDate(item.timestamp), formatDuration(item.durationSeconds), item.fromMe ? 'Tú' : ''].filter(Boolean).join(' · ');
    copy.append(make('small', 'media-library-meta', meta));
    const actions = make('div', 'media-library-actions');
    const chatButton = control('media-library-chat', item.chatName);
    chatButton.setAttribute('aria-label', `Abrir chat ${item.chatName}`);
    chatButton.onclick = () => openChat(item);
    actions.append(chatButton);
    if (item.kind === 'document' && item.url) {
      const open = make('a', 'media-library-open', 'Abrir archivo');
      open.href = item.url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      actions.append(open);
    }
    copy.append(actions);
    element.append(copy);
    if (selecting) {
      for (const child of element.children) child.inert = true;
      const toggle = control('media-library-select');
      const chosen = selected.has(item.id);
      toggle.setAttribute('aria-label', `${chosen ? 'Deseleccionar' : 'Seleccionar'} ${titleFor(item)}`);
      toggle.setAttribute('aria-pressed', String(chosen));
      toggle.disabled = acting;
      toggle.onclick = () => {
        if (selected.has(item.id)) selected.delete(item.id);
        else selected.set(item.id, item);
        render();
        [...list.children].find(card => card.dataset.id === item.id)?.querySelector('.media-library-select')?.focus();
      };
      element.classList.add('is-selecting');
      element.append(toggle);
    }
    return element;
  }

  async function load({ append = false } = {}) {
    if (!append) { selected.clear(); actionSeq += 1; acting = false; }
    const account = getAccount();
    if (!account) {
      requestSeq += 1;
      items = []; nextCursor = null; failure = ''; loadedSignature = ''; loading = false;
      notice = 'Selecciona una cuenta de WhatsApp para ver su contenido.';
      render();
      return;
    }
    notice = '';
    client.invalidate();
    const token = { seq: ++requestSeq, account, signature: signature(), params: requested(), append };
    const fresh = () => token.seq === requestSeq && !overlay.hidden
      && token.account === getAccount() && token.signature === signature();
    loading = true;
    failure = '';
    render();
    try {
      const result = await client.page({ ...token.params, cursor: append ? nextCursor : null });
      if (!result || !fresh()) return;
      items = append ? [...items, ...result.items] : result.items;
      nextCursor = result.nextCursor;
      loadedSignature = token.signature;
    } catch (error) {
      if (!fresh()) return;
      if (!append) items = [];
      nextCursor = null;
      failure = error?.message || 'No se pudo cargar el contenido multimedia.';
    } finally {
      if (fresh()) { loading = false; render(); }
    }
  }

  function open() {
    opener = documentRef.activeElement;
    overlay.hidden = false;
    entry.setAttribute('aria-expanded', 'true');
    onOpen();
    closeButton.focus();
    render();
    if (loadedSignature !== signature() || failure) void load();
  }

  function close() {
    if (overlay.hidden) return;
    windowRef?.clearTimeout?.(searchTimer);
    client.invalidate();
    requestSeq += 1;
    actionSeq += 1; acting = false;
    items = []; nextCursor = null; failure = ''; loading = false; loadedSignature = '';
    selecting = false; selected.clear();
    searching = false; searchInput.value = '';
    closePreview(); actionShade.hidden = true;
    overlay.hidden = true;
    entry.setAttribute('aria-expanded', 'false');
    opener?.focus?.();
  }

  function switchTab(kind) {
    if (kind === tab || !TAB_LABELS.has(kind)) return;
    tab = kind;
    if (kind !== 'media' && orderFilter.input.value === 'longest') orderFilter.input.value = 'newest';
    actionSeq += 1; acting = false;
    selected.clear();
    closePreview(); actionShade.hidden = true;
    items = []; nextCursor = null; failure = '';
    void load();
  }

  entry.onclick = () => (overlay.hidden ? open() : close());
  searchToggle.onclick = () => { searching = true; closePreview(); render(); searchInput.focus(); };
  searchClose.onclick = () => { windowRef?.clearTimeout?.(searchTimer); searching = false; searchInput.value = ''; items = []; nextCursor = null; void load(); tabs.querySelector('[aria-selected="true"]')?.focus(); };
  selectButton.onclick = () => { selecting = !selecting; selected.clear(); closePreview(); render(); };
  downloadButton.onclick = () => {
    if (downloadButton.disabled) return;
    for (const item of selected.values()) {
      const link = make('a');
      link.href = item.url;
      link.download = item.name || `${item.kind}-${item.messageId}`;
      documentRef.body.append(link);
      link.click();
      link.remove();
    }
  };
  const selectedMessages = () => uniqueMediaMessages(selected.values());
  const actionCurrent = token => !overlay.hidden && token.account === getAccount() && token.seq === requestSeq && token.action === actionSeq;
  async function runAction(path, extra, successText) {
    const token = { account: getAccount(), seq: requestSeq, action: actionSeq + 1 };
    const messages = selectedMessages();
    if (!messages.length || acting || !token.account) return;
    actionSeq = token.action;
    acting = true; notice = ''; actionError = false; render();
    let completed = 0;
    let errorText = '';
    for (const message of messages) {
      if (!actionCurrent(token)) break;
      try {
        const result = await api(path, { account: token.account, ...message, ...extra });
        if (result?.account !== token.account || result.confirmed !== true) throw new Error('La acción no fue confirmada.');
        if (!actionCurrent(token)) break;
        completed += 1;
        for (const [id, item] of selected) {
          if (item.chatId === message.chat && item.messageId === message.messageId) selected.delete(id);
        }
        if (path === '/api/messages/delete') items = items.filter(item => item.chatId !== message.chat || item.messageId !== message.messageId);
      } catch (error) { errorText = error?.message || 'No se pudo completar la acción.'; break; }
    }
    if (!actionCurrent(token)) return;
    acting = false;
    actionError = Boolean(errorText);
    const completedText = completed ? `${completed} mensaje${completed === 1 ? '' : 's'} ${successText}.` : '';
    notice = errorText
      ? `${completedText} ${errorText}${path === '/api/messages/forward' ? ' Comprueba el chat de destino antes de reintentar.' : ''}`.trim()
      : completedText;
    render();
  }
  function openAction(title, build) {
    if (!selected.size || acting) return;
    actionDialog.replaceChildren();
    const heading = make('h3', '', title);
    const cancel = control('media-library-selection-action is-subtle', 'Cancelar');
    cancel.onclick = () => { actionShade.hidden = true; selectButton.focus(); };
    actionDialog.append(heading);
    build(actionDialog, cancel);
    actionShade.hidden = false;
    cancel.focus();
  }
  actionShade.onclick = event => { if (event.target === actionShade) { actionShade.hidden = true; selectButton.focus(); } };
  starButton.onclick = () => void runAction('/api/chat-actions', { action: 'starred' }, 'destacado');
  deleteButton.onclick = () => openAction('Eliminar mensajes seleccionados', (dialog, cancel) => {
    dialog.append(make('p', '', 'Elige cómo quieres eliminarlos.'));
    const me = control('media-library-selection-action', 'Eliminar para mí');
    me.onclick = () => { actionShade.hidden = true; void runAction('/api/messages/delete', { scope: 'me' }, 'eliminado'); };
    const everyone = control('media-library-selection-action is-subtle', 'Eliminar para todos');
    everyone.disabled = [...selected.values()].some(item => !item.fromMe);
    everyone.onclick = () => { actionShade.hidden = true; void runAction('/api/messages/delete', { scope: 'everyone' }, 'eliminado'); };
    dialog.append(me, everyone, cancel);
  });
  forwardButton.onclick = () => openAction('Reenviar mensajes', (dialog, cancel) => {
    const label = make('label', 'media-library-action-target', 'Conversación de destino');
    const target = make('select');
    target.setAttribute('aria-label', 'Conversación de destino');
    const empty = make('option', '', 'Selecciona una conversación'); empty.value = ''; target.append(empty);
    for (const chat of getChats()) {
      const option = make('option', '', chat.name || chat.id); option.value = chat.id; target.append(option);
    }
    const send = control('media-library-selection-action', 'Reenviar');
    send.disabled = true;
    target.onchange = () => { send.disabled = !target.value; };
    send.onclick = () => { if (!target.value) return; actionShade.hidden = true; void runAction('/api/messages/forward', { targetChat: target.value }, 'reenviado'); };
    label.append(target); dialog.append(label, send, cancel);
  });
  closeButton.onclick = close;
  previewClose.onclick = () => hidePreview(true);
  for (const tabButton of tabButtons) tabButton.onclick = () => switchTab(tabButton.dataset.kind);
  tabs.addEventListener('keydown', event => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = tabButtons.findIndex(tabButton => tabButton.dataset.kind === tab);
    const next = tabButtons[(index + (event.key === 'ArrowRight' ? 1 : tabButtons.length - 1)) % tabButtons.length];
    next.focus();
    switchTab(next.dataset.kind);
  });
  searchInput.addEventListener('input', () => {
    windowRef?.clearTimeout?.(searchTimer);
    searchTimer = windowRef?.setTimeout?.(() => { void load(); }, 350);
  });
  senderFilter.input.onchange = () => { items = []; nextCursor = null; void load(); };
  orderFilter.input.onchange = () => { items = []; nextCursor = null; void load(); };
  more.onclick = () => load({ append: true });
  retry.onclick = () => void load();
  documentRef.addEventListener('keydown', event => {
    if (overlay.hidden || event.defaultPrevented) return;
    if (event.key === 'Escape') { event.preventDefault(); if (!actionShade.hidden) { actionShade.hidden = true; selectButton.focus(); } else if (preview.hidden) close(); else hidePreview(true); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...(actionShade.hidden ? panel : actionDialog).querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]')]
      .filter(element => !element.closest('[hidden]'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && documentRef.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && documentRef.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  documentRef.addEventListener('pointerdown', event => {
    if (!overlay.hidden && !panel.contains(event.target) && !entry.contains(event.target)) close();
  });

  render();
  return {
    // Exposed for the app.js mutual-exclusion hook: opening communities, profile or
    // settings must close this dialog even when the keyboard produced no pointerdown.
    close,
    accountChanged() {
      windowRef?.clearTimeout?.(searchTimer);
      client.invalidate();
      requestSeq += 1;
      actionSeq += 1; acting = false;
      items = []; nextCursor = null; failure = ''; loading = false; loadedSignature = ''; notice = '';
      selected.clear();
      closePreview(); actionShade.hidden = true;
      if (overlay.hidden) render();
      else void load();
    },
  };
}
