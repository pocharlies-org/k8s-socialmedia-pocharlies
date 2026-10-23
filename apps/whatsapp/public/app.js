'use strict';
let needsMessageRecovery;
let recoveryLabel;
let historyRecoveryWaitMs;
const recoveryReady = import('./history-recovery.mjs').then(module => {
  ({ needsMessageRecovery, recoveryLabel } = module);
  historyRecoveryWaitMs = module.HISTORY_RECOVERY_WAIT_MS;
});
let mergeMessages;
let compareMessages;
let mergeRecentMessages;
let pinnedFirst;
let shouldSubmitMessageKey;
let visibleOutgoingMessages;
const historyReady = import('./chat-history.mjs').then(module => {
  ({mergeMessages, compareMessages, mergeRecentMessages, pinnedFirst, shouldSubmitMessageKey, visibleOutgoingMessages} = module);
});
const $ = id => document.getElementById(id);
function safeLocalStorage() { try { return globalThis.localStorage; } catch { return null; } }
let messageRenderer = null;
const rendererReady = import('./message-render.mjs').then(module => { messageRenderer = module; return module; });
let attachmentTools = null;
const attachmentReady = import('./composer-attachment.mjs').then(module => { attachmentTools = module; return module; });
let mediaTools = null;
let cameraController = null;
let photoEditor = null;
const mediaReady = import('./composer-media.mjs').then(module => {
  mediaTools = module;
  cameraController = module.createCameraController({documentRef: document, mediaDevices: navigator.mediaDevices,
    getContext: context, isCurrent: current, onCapture: stageAttachment, showError: error});
  return module;
});
const photoEditorReady = import('./photo-editor.mjs').then(module => {
  photoTools = module;
  photoEditor = module.createPhotoEditor({documentRef: document,
    getContext: context, isCurrent: current, showError: error});
  if (pendingFiles?.length) renderStagedFiles();
  return module;
});
let photoTools = null;
function applyPhotoEdit(entry, editedFile) {
  const problem = attachmentTools.attachmentError(editedFile);
  if (problem) { error(`${entry.file?.name || 'Imagen'}: ${problem}`); return false; }
  if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  entry.file = editedFile;
  entry.previewUrl = URL.createObjectURL(editedFile);
  if (!attachmentTools.canViewOnce(editedFile)) entry.viewOnce = false;
  error();
  renderStagedFiles();
  return true;
}
let accountRailTools = null;
const accountRailReady = import('./account-rail.mjs').then(module => { accountRailTools = module; return module; });
let draftTools = null;
const draftReady = import('./draft-suggest.mjs').then(module => { draftTools = module; return module; });
let assistant = null;
const assistantReady = draftReady.catch(() => null).then(() => import('./assistant-ui.generated.js')).then(({mountAssistant}) => {
  const agentCopy = draftTools || {DRAFT_INSTRUCTION: '', DRAFT_LABEL: ''};
  assistant = mountAssistant($('ai-root'), {
    request: api,
    draftPrompt: agentCopy.DRAFT_INSTRUCTION,
    draftLabel: agentCopy.DRAFT_LABEL,
    useDraft(text, ctx) {
      if (!current(ctx)) return;
      applyDraft(text, ctx);
      toggleAI(false);
    }
  });
  assistant.select(context());
  assistant.setOpen(!$('ai-panel').hidden);
  return assistant;
}).catch(err => { $('ai-root').textContent = `No se pudo cargar el asistente: ${err.message}`; });
let featureUI = null;
let communitiesUI = null;
let profileUI = null;
let mediaLibraryUI = null;
let novedadesUI = null;
let pinnedUI = null;
let liveUpdates = null;
const liveReady = import('./live-updates.mjs').then(({createLiveUpdates}) => {
  liveUpdates = createLiveUpdates({onHint: hint => featureUI?.reactionHint?.(hint), refresh: async ({hidden}) => {
    await Promise.all([loadChats({background: true}), hidden ? null : loadMessages(), hidden ? null : pinnedUI?.refresh()]);
  }});
});
const state = {account: '', chat: '', chats: [], messages: [], historyMode: false, historyCursor: null, historyInitialized: false, loadingOlder: false, chatFilter: 'all', chatRequestToken: 0, messageRequestToken: 0, selectedChat: null, sending: false, version: 0, busy: false, suggesting: false, signature: '', drafts: new Map(), outgoing: new Map(), pollSelections: new Map(), pollSubmitted: new Map(), pollDirty: new Set(), pollAttempts: new Map(), pollBusy: new Set(), recorder: null, stream: null, blob: null, recordingUrl: '', recordingToken: 0, recordingSendToken: null};
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
const historyNotice = node('div', 'notice');
const recoveryStates = new Map();
const recoveryTimers = new Map();
const recoveryRequests = new Map();
const recoveryNotice = node('div', 'notice');
recoveryNotice.hidden = true;
$('messages').before(recoveryNotice);

function updateRecoveryNotice() {
  const status = recoveryStates.get(`${state.account}:${state.chat}`);
  recoveryNotice.hidden = !state.chat || state.historyMode || !needsMessageRecovery(state.messages) || !status;
  recoveryNotice.replaceChildren(node('span', '', recoveryLabel(status)));
  if (['failed', 'no_anchor', 'cooldown', 'timeout'].includes(status)) {
    const retry = node('button', 'text-button', 'Reintentar');
    retry.onclick = () => void recoverMessages(context(), true);
    recoveryNotice.append(retry);
  }
}

function setRecoveryStatus(key, status) {
  clearTimeout(recoveryTimers.get(key));
  recoveryTimers.delete(key);
  recoveryStates.set(key, status);
  if (['pending', 'requested', 'cooldown'].includes(status)) {
    recoveryTimers.set(key, setTimeout(() => {
      recoveryTimers.delete(key);
      recoveryStates.set(key, 'timeout');
      if (`${state.account}:${state.chat}` === key) updateRecoveryNotice();
    }, historyRecoveryWaitMs));
  }
}

async function recoverMessages(ctx, retry = false) {
  const key = `${ctx.account}:${ctx.chat}`;
  if (!current(ctx) || (!retry && recoveryStates.has(key)) || recoveryStates.get(key) === 'pending') return;
  const request = Symbol();
  recoveryRequests.set(key, request);
  setRecoveryStatus(key, 'pending'); updateRecoveryNotice();
  try {
    const result = await api('/api/messages/recover', { account: ctx.account, chat: ctx.chat });
    if (recoveryRequests.get(key) !== request || recoveryStates.get(key) !== 'pending') return;
    setRecoveryStatus(key, result.status);
    if (current(ctx)) { updateRecoveryNotice(); if (result.recovered > 0) void loadMessages(); }
  } catch {
    if (recoveryRequests.get(key) !== request || recoveryStates.get(key) !== 'pending') return;
    setRecoveryStatus(key, 'failed'); if (current(ctx)) updateRecoveryNotice();
  }
}
historyNotice.id = 'history-notice';
historyNotice.hidden = true;
historyNotice.append(node('span', '', 'Mostrando mensajes antiguos. '));
const showRecent = node('button', 'feature-button', 'Volver a recientes');
showRecent.type = 'button';
showRecent.onclick = () => { state.historyMode = false; historyNotice.hidden = true; resetMessageHistory(); state.signature = ''; $('messages').replaceChildren(node('div', 'welcome', 'Cargando mensajes…')); loadMessages(); };
historyNotice.append(showRecent);
$('messages').before(historyNotice);
// UX #2.3: WhatsApp no tiene botón «Cargar mensajes anteriores»: el histórico
// entra al llegar arriba. El aviso solo muestra el spinner durante la carga.
const olderNotice = node('div', 'notice');
olderNotice.hidden = true;
olderNotice.append(node('span', '', 'Cargando mensajes anteriores…'));
$('messages').before(olderNotice);
// QA 22-10: sin botón «ir abajo», volver al final de un chat largo era a pulso.
const scrollBottom = node('button', 'scroll-bottom', '↓');
scrollBottom.type = 'button';
scrollBottom.setAttribute('aria-label', 'Ir al final del chat');
scrollBottom.title = 'Ir al final del chat';
scrollBottom.hidden = true;
scrollBottom.onclick = () => $('messages').scrollTo({top: $('messages').scrollHeight, behavior: 'smooth'});
$('messages').after(scrollBottom);
function updateScrollBottom() {
  const pane = $('messages');
  scrollBottom.hidden = !state.chat || pane.scrollHeight - pane.scrollTop - pane.clientHeight < 300;
}
$('messages').addEventListener('scroll', () => {
  if ($('messages').scrollTop < 80) updateOlderControl();
  updateScrollBottom();
});
function updateOlderControl() {
  olderNotice.hidden = !state.loadingOlder;
  updateScrollBottom();
  const pane = $('messages');
  // Si el hilo no desborda el panel no hay scroll que dispare: se rellena solo
  // hasta llenar la vista (para cuando historyCursor se agota).
  if (state.chat && state.historyCursor && !state.loadingOlder && (pane.scrollTop < 80 || pane.scrollHeight <= pane.clientHeight + 80)) void loadOlderMessages();
}
function resetMessageHistory() {
  void pinnedUI?.refresh();
  state.messages = [];
  state.historyCursor = null;
  state.historyInitialized = false;
  state.loadingOlder = false;
  updateOlderControl();
  recoveryNotice.hidden = true;
}
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
const getInflight = new Map();
// QA #14: abrir «Novedades» pedía 3 veces la misma URL de autores (la hoja, el
// monitor de notificaciones y el re-render). GETs concurrentes a la misma ruta
// comparten una petición; las siguientes siguen revalidando (criterio igual que
// la coalescencia de /api/chats en la PR #302).
function api(path, data, onEvent, requestSignal) {
  if (data || onEvent || requestSignal) return apiOnce(path, data, onEvent, requestSignal);
  const running = getInflight.get(path);
  if (running) return running;
  const run = apiOnce(path).finally(() => getInflight.delete(path));
  getInflight.set(path, run);
  return run;
}
async function apiOnce(path, data, onEvent, requestSignal) {
  const signal = requestSignal || (onEvent ? AbortSignal.timeout(240000) : undefined);
  const timeoutError = () => new Error(path === '/api/novedades/status'
    ? 'Se agotó el tiempo de espera del estado. Comprueba si se publicó antes de reintentar.'
    : 'Se agotó el tiempo de espera del agente. Comprueba el chat antes de repetir una acción.');
  const response = await fetch(path, {
    credentials: 'same-origin',
    signal,
    headers: data ? {'Content-Type': 'application/json'} : {},
    ...(data ? {method: 'POST', body: JSON.stringify(data)} : {})
  }).catch(error => { throw signal?.aborted ? timeoutError() : error; });
  if (response.ok && onEvent && response.headers.get('content-type')?.includes('text/event-stream')) {
    const {readAgentStream} = await import('./agent-stream.mjs');
    return readAgentStream(response, onEvent).catch(error => { throw signal?.aborted ? timeoutError() : error; });
  }
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`Respuesta del servidor no válida (${response.status}).`); }
  if (response.status === 401 && result?.code === 'AUTH_REQUIRED') {
    try { sessionStorage.removeItem(OUTBOX_STORAGE_KEY); } catch {}
    const returnTo = `${location.pathname}${location.search}`;
    if (location.pathname !== '/auth/login') location.assign(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    throw new Error('La sesión ha expirado. Redirigiendo al inicio de sesión…');
  }
  if (!response.ok) {
    const failure = new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || `Error del servidor (${response.status}).`);
    failure.code = typeof result.code === 'string' ? result.code : typeof result.error?.code === 'string' ? result.error.code : '';
    failure.status = response.status;
    failure.outcomeUncertain = result.outcomeUncertain === true;
    throw failure;
  }
  return result;
}
function query(path, extra = {}) { return `${path}?${new URLSearchParams({account: state.account, ...extra})}`; }
function context() { return {account: state.account, chat: state.chat, version: state.version}; }
function current(ctx) { return ctx.version === state.version && ctx.account === state.account && ctx.chat === state.chat; }
function updateControls() { const disabled = !state.account || !state.chat || !state.sending; for (const id of ['message', 'attach', 'record', 'send']) $(id).disabled = disabled; const emoji = $('feature-emoji'); if (emoji) emoji.disabled = disabled; const suggest = $('suggest'); suggest.disabled = !state.account || !state.chat || state.suggesting || state.busy; suggest.setAttribute('aria-busy', String(state.suggesting)); suggest.classList.toggle('is-busy', state.suggesting); $('record').disabled ||= state.busy || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder; $('sending-notice').hidden = state.sending; }
// QA #108: data-theme también en <html> (la scrollbar y los controles nativos se pintan por el
// root; body{color-scheme} no llega ahí) y el meta theme-color sigue al tema (en móvil claro la
// barra del navegador salía oscura sobre una app beige).
function setTheme(value) {
  const theme = value === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : value;
  document.body.dataset.theme = document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#efeae2' : '#161717';
  try { localStorage.setItem('wa-theme', value); } catch {}
}
try { const storedTheme = localStorage.getItem('wa-theme'); $('theme').value = ['dark', 'light', 'system'].includes(storedTheme) ? storedTheme : 'dark'; } catch { $('theme').value = 'dark'; }
setTheme($('theme').value); $('theme').onchange = () => setTheme($('theme').value); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTheme($('theme').value));
function chatFilterValue() { return state.chatFilter; }
function chatMatchesFilter(chat, filter) {
  if (featureUI?.matchesChat && !featureUI.matchesChat(chat, filter)) return false;
  if (filter === 'unread') return Number(chat.unread) > 0 || chat.unread === true;
  if (filter === 'groups') return chat.isGroup === true;
  return true;
}
const avatarFailures = new Set(); // QA #82: el 404 de un chat sin foto se re-pedía en cada repintado
function chatAvatar(chat) {
  const avatar = node('span', 'avatar');
  const key = String(chat.id ?? '');
  const url = avatarFailures.has(key) ? null : messageRenderer?.safeMessageUrl(chat.avatarUrl || chat.avatar_url);
  if (url) { const image = node('img', 'chat-avatar-image'); image.src = url; image.alt = ''; image.loading = 'lazy'; image.onerror = () => { if (key) avatarFailures.add(key); avatar.replaceChildren(); avatar.textContent = chatInitials(chat); }; avatar.append(image); }
  else avatar.textContent = chatInitials(chat);
  return avatar;
}
// UX #45.2: la inicial es un grapheme completo (una bandera son dos code points).
// app.js es script clásico y no puede importar public/text-initials.mjs: mismo criterio aquí.
const chatGraphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('es', {granularity: 'grapheme'}) : null;
function chatGraphemesOf(value) {
  return chatGraphemes ? [...chatGraphemes.segment(value)].map(grapheme => grapheme.segment) : [...value];
}
function chatInitials(chat) {
  const value = String(chat?.name || chat?.id || 'SocialMedia').trim();
  const parts = value.split(/\s+/).filter(Boolean);
  if (!parts.length) return 'S';
  return (parts.length > 1
    ? chatGraphemesOf(parts[0])[0] + chatGraphemesOf(parts[1])[0]
    : chatGraphemesOf(parts[0]).slice(0, 2).join('')).toLocaleUpperCase();
}
function setConversationAvatar(chat = null) {
  const avatar = document.querySelector('.conversation-avatar');
  if (!avatar) return;
  avatar.replaceChildren();
  const url = messageRenderer?.safeMessageUrl(chat?.avatarUrl || chat?.avatar_url);
  if (url) {
    const image = node('img', 'conversation-avatar-image');
    image.src = url;
    image.alt = '';
    image.loading = 'lazy';
    image.onerror = () => { avatar.replaceChildren(); avatar.textContent = chatInitials(chat); };
    avatar.append(image);
  } else avatar.textContent = chatInitials(chat);
}
// QA #87: el servidor pliega tildes (pg_trgm); la lista debe plegar igual o «ibanez» no encuentra nada.
const foldSearch = value => value.toLocaleLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
function renderChats() {
  // QA #89/#97: «Destacados» es una vista de mensajes, no de chats.
  if (featureUI?.isFeatureView?.() === 'starred') { $('chat-status').textContent = ''; void featureUI.starredView?.($('chats')); return; }
  const archivedView = featureUI?.isFeatureView?.() === 'archived';
  sidebarSearch?.viewChanged(archivedView);
  // UX #6.1: el buscador filtra también dentro de Archivados (antes se vaciaba).
  const search = foldSearch($('search').value.trim());
  // QA #125 (22-10): un término todo dígitos busca también por el número del chat
  // (id de conversación o waChatId), no solo por el texto pintado.
  const term = $('search').value.trim();
  const digits = term.replace(/\D/g, '');
  const numeric = /^\+?[\d\s]{5,}$/.test(term);
  const numberMatches = chat => numeric && [chat.id, chat.waChatId].some(value => String(value ?? '').replace(/\D/g, '').includes(digits));
  const filter = chatFilterValue();
  state.chatFilter = filter;
  const chats = pinnedFirst(state.chats.filter(chat => chatMatchesFilter(chat, filter) && (foldSearch(`${chat.name || ''} ${chat.preview || ''}`).includes(search) || numberMatches(chat))));
  $('chat-count').textContent = String(state.chats.length);
  // QA #74: la pestaña no avisaba de los no leídos (title fijo «SocialMedia»).
  const unreadTotal = state.chats.reduce((sum, chat) => sum + (chat.unread === true ? 1 : Math.max(0, Number(chat.unread) || 0)), 0);
  document.title = unreadTotal ? `(${unreadTotal > 99 ? '99+' : unreadTotal}) WhatsApp` : 'WhatsApp';
  $('chats').replaceChildren();
  for (const chat of chats) {
    const button = node('button', `chat-item${chat.isGroup === true ? ' is-group' : ''}`);
    button.type = 'button';
    button.dataset.chatId = chat.id;
    button.setAttribute('aria-current', String(chat.id === state.chat));
    button.append(chatAvatar(chat));
    const details = node('span', 'chat-details');
    const nameRow = node('span', 'chat-name-row');
    nameRow.append(node('span', 'chat-name', chat.name || chat.id));
    if (featureUI?.isChatPinned?.(chat) || chat.pinned === true || chat.isPinned === true) {
      const pin = node('span', 'chat-pin');
      // UX #58.4: un span con aria-label sin rol se lo salta NVDA en modo formulario.
      pin.setAttribute('role', 'img');
      pin.setAttribute('aria-label', 'Chat fijado');
      pin.title = 'Chat fijado';
      nameRow.append(pin);
    }
    // QA 22-10: el favorito se filtraba pero no se veía en la fila de «Todos».
    if (featureUI?.isChatFavorite?.(chat) || chat.favorite === true || chat.isFavorite === true) {
      const fav = node('span', 'chat-fav');
      fav.setAttribute('aria-label', 'Chat destacado');
      fav.title = 'Chat destacado';
      nameRow.append(fav);
    }
    if (chat.muted === true || chat.isMuted === true) {
      const muted = node('span', 'chat-muted', 'Silenciado');
      muted.setAttribute('aria-label', 'Chat silenciado');
      muted.title = 'Chat silenciado';
      nameRow.append(muted);
    }
    if (chat.timestamp && messageRenderer) { const label = messageRenderer.formatChatListTime(chat.timestamp); if (label) { const time = node('time', 'chat-time', label); const date = new Date(typeof chat.timestamp === 'number' && chat.timestamp < 1e12 ? chat.timestamp * 1000 : chat.timestamp); if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString(); nameRow.append(time); } }
    details.append(nameRow, messageRenderer ? messageRenderer.renderChatPreview(chat) : node('span', 'chat-preview', chat.preview || 'Sin mensajes disponibles'));
    button.append(details);
    if (Number(chat.unread) > 0 || chat.unread === true) button.append(node('span', 'badge', String(chat.unread === true ? '' : chat.unread)));
    // UX #4.5: el nombre accesible de la fila se derivaba del DOM y la elipsis CSS
    // no oculta el texto al lector de pantalla: filas con mensajes largos =
    // etiquetas de párrafos enteros. Nombre + previsualización truncados a 120.
    // QA #101 (22-10): el aria-label del botón manda sobre el badge interior, así que
    // el silencio debe ir en la etiqueta de la fila o un lector la lee igual que una normal.
    const rowLabel = `${chat.name || chat.id}: ${chat.preview || 'Sin mensajes disponibles'}${chat.muted === true || chat.isMuted === true ? ' · Silenciado' : ''}`;
    button.setAttribute('aria-label', rowLabel.length > 120 ? `${rowLabel.slice(0, 120)}…` : rowLabel);
    // QA #75: click con ratón (detail ≥1) no roba foco; Enter/espacio (detail 0)
    // abre y deja el cursor en el composer, como la oficial.
    button.onclick = event => selectChat(chat, { focusComposer: event?.detail === 0 });
    const row = node('div', 'chat-row');
    const menu = node('button', 'chat-row-menu', '⌄');
    menu.type = 'button';
    menu.setAttribute('aria-label', `Opciones de ${chat.name || chat.id}`);
    menu.setAttribute('aria-haspopup', 'menu');
    const openMenu = event => { event.preventDefault(); featureUI?.openSidebarChatMenu(chat, menu); };
    menu.onclick = openMenu;
    row.oncontextmenu = openMenu;
    button.onkeydown = event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event); };
    // UX 21.2: fijar/silenciar/archivar al hover (y con foco de teclado), sin
    // pasar por «⌄». Con 1000+ chats es la diferencia entre 10 s y 5 min.
    const quicks = [];
    for (const [action, glyph, label] of [
      ['pin', '📌', chat.pinned === true || chat.isPinned === true ? 'Desfijar chat' : 'Fijar chat'],
      ['mute', '🔕', chat.muted === true || chat.isMuted === true ? 'Activar sonido' : 'Silenciar chat'],
      ['archive', '🗂️', 'Archivar chat'],
    ]) {
      const quick = node('button', `chat-quick chat-quick-${action}`, glyph);
      quick.type = 'button';
      quick.setAttribute('aria-label', label);
      quick.title = label;
      quick.onclick = event => { event.stopPropagation(); void featureUI?.quickChatAction?.(chat, action); };
      quicks.push(quick);
    }
    row.append(button, menu, ...quicks);
    $('chats').append(row);
  }
  // QA #125: un número sin coincidencia en el listado no es un callejón — ofrece abrir
  // el chat con ese número (el directorio ya sabe empezar chats por teléfono).
  if (numeric && !chats.length && state.chats.length) {
    const offer = node('button', 'chat-item');
    offer.type = 'button';
    offer.textContent = `Chatear con +${digits}`;
    offer.onclick = () => featureUI?.openNewChat?.('chat', digits);
    $('chats').append(offer);
  }
  // UX #39.2: cada filtro vacío enseña qué le falta y dónde se marca (la oficial).
  const emptyFilters = {favorites: 'Aún no has destacado ningún chat. Toca «⌄» en cualquier chat y elige «Destacar chat».', unread: 'No tienes chats sin leer.', groups: 'Todavía no compartes ningún grupo.'};
  $('chat-status').textContent = !state.chats.length ? (filter === 'archived' ? 'No hay chats archivados.' : 'Todavía no hay chats sincronizados para esta cuenta.') : !chats.length ? (emptyFilters[filter] || 'No hay conversaciones que coincidan.') : '';
}
const chatLoads = new Map();
const chatCache = new Map();
// Jordi 22-10 (criterio de Dani: sin pantallas de carga): la última lista de cada
// ámbito se guarda en localStorage y se pinta al abrir, incluso tras F5.
const CHATS_CACHE_PREFIX = 'wa-chats-cache-v1:';
try {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(CHATS_CACHE_PREFIX)) chatCache.set(key.slice(CHATS_CACHE_PREFIX.length), {chats: JSON.parse(localStorage.getItem(key))});
  }
} catch { /* caché corrupta: se rellena de la red */ }
function rememberChats(scope, chats) {
  try { localStorage.setItem(CHATS_CACHE_PREFIX + scope, JSON.stringify(chats)); } catch { /* cuota: la memoria de la sesión basta */ }
}
async function loadChats({background = false} = {}) {
  if (!state.account || (background && state.chatLoading)) return;
  const account = state.account;
  const archivedView = featureUI?.isFeatureView?.() === 'archived';
  const scope = `${account}:${archivedView}`;
  // QA velocidad 3: 22 peticiones a /api/chats en una sola apertura (init +
  // módulos + SSE). Las concurrentes del mismo ámbito comparten una carga;
  // las posteriores siguen revalidando (el eco de un envío debe verse).
  const running = chatLoads.get(scope);
  if (running) return running;
  const requestToken = ++state.chatRequestToken;
  // QA velocidad 22-10: cambiar de cuenta costaba ~9 s (arranque frío cada vez).
  // Se pinta enseguida la última lista conocida de ese ámbito y se revalida.
  const remembered = chatCache.get(scope)?.chats || [];
  const previous = state.chatListScope === scope ? state.chats : remembered;
  if (previous.length && state.chatListScope !== scope) {
    state.chats = previous; state.chatListScope = scope;
    featureUI?.chatsChanged?.(state.chats); renderChats();
  }
  const isCurrent = () => account === state.account && requestToken === state.chatRequestToken && archivedView === (featureUI?.isFeatureView?.() === 'archived');
  const run = (async () => {
    state.chatLoading = true;
    try {
      const {loadChatPages} = await import('./chat-directory.mjs');
      await loadChatPages({previous, isCurrent,
        fetchPage: cursor => api(`/api/chats?${new URLSearchParams({account, limit: '100', ...(archivedView ? {archived: 'only'} : {}), ...(cursor ? {cursor} : {})})}`),
        onPage: chats => {
          state.chats = chats; state.chatListScope = scope; chatCache.set(scope, {chats});
          rememberChats(scope, chats);
          featureUI?.chatsChanged?.(state.chats);
          // Jordi 22-10: sin aviso «Cargando más conversaciones…»: la lista ya está
          // pintada y crece sola; el aviso era ruido sobre contenido útil.
        },
      });
    } catch (err) {
      if (isCurrent()) $('chat-status').textContent = err.message;
    } finally {
      if (requestToken === state.chatRequestToken) state.chatLoading = false;
    }
  })();
  chatLoads.set(scope, run);
  try { return await run; } finally { chatLoads.delete(scope); }
}
function outgoingKey(account, chat) { return `${account}:${chat}`; }
function outgoingFor(account, chat) { return state.outgoing.get(outgoingKey(account, chat)) || []; }
function matchesConfirmedMessage(item, message) {
  if (!item.messageId || !message.fromMe) return false;
  const storedId = String(message.waMessageId || message.id);
  return storedId === String(item.messageId) || storedId === `${item.account}:${item.messageId}`;
}
const OUTBOX_STORAGE_KEY = 'wa-unconfirmed-outbox-v1';
const OUTBOX_TTL_MS = 30 * 60 * 1000;
let outboxScope = '';
function persistOutbox() {
  if (!outboxScope) return;
  const now = Date.now();
  const entries = [...state.outgoing.values()].flat().filter(item => now - new Date(item.timestamp).getTime() < OUTBOX_TTL_MS).slice(-20).map(item => ({
    id:item.id, account:item.account, chat:item.chat, text:item.text.slice(0, 20000), timestamp:item.timestamp,
    state:item.state, messageId:item.messageId, replyTo:item.replyTo, sendToken:item.sendToken, retryable:item.text.length <= 20000, fileName:item.file?.name || item.fileName || '', viewOnce:item.viewOnce === true,
    knownIds:[...(item.knownIds || [])].slice(-100),
  }));
  try { if (entries.length) sessionStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify({scope:outboxScope, entries})); else sessionStorage.removeItem(OUTBOX_STORAGE_KEY); } catch {}
}
function restoreOutbox(scope) {
  try {
    outboxScope = scope;
    const saved = JSON.parse(sessionStorage.getItem(OUTBOX_STORAGE_KEY) || 'null');
    if (saved && (!scope || saved.scope !== scope || !Array.isArray(saved.entries))) { sessionStorage.removeItem(OUTBOX_STORAGE_KEY); return; }
    for (const entry of (saved?.entries || []).slice(-20)) {
      const age = Date.now() - new Date(entry?.timestamp).getTime();
      if (!entry || typeof entry.account !== 'string' || !entry.account || entry.account.length > 128 || typeof entry.chat !== 'string' || !entry.chat || entry.chat.length > 1024 || typeof entry.id !== 'string' || typeof entry.text !== 'string' || entry.text.length > 20000 || !Number.isFinite(age) || age < 0 || age > OUTBOX_TTL_MS) continue;
      const item = {...entry, sendToken:entry.retryable !== false && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.sendToken || '') ? entry.sendToken : null, file:null,
        knownIds:new Set(Array.isArray(entry.knownIds) ? entry.knownIds.filter(id => typeof id === 'string').slice(-100) : []), state:entry.state === 'confirmed' ? 'confirmed' : 'failed'};
      const key = outgoingKey(item.account, item.chat);
      state.outgoing.set(key, [...outgoingFor(item.account, item.chat), item]);
    }
    persistOutbox();
  } catch { try { sessionStorage.removeItem(OUTBOX_STORAGE_KEY); } catch {} }
}
function pollKey(message) { return `${state.account}:${state.chat}:${message.id}`; }
function samePollOptions(left, right) {
  return left.size === right.size && [...left].every(index => right.has(index));
}
function recordedPollOptions(message) {
  const key = pollKey(message);
  const selected = new Set();
  for (const [index, name] of (message.metadata?.options || []).entries()) {
    if (message.metadata?.results?.options?.find(option => option.name === name)?.selectedByMe) selected.add(index);
  }
  const submitted = state.pollSubmitted.get(key);
  if (submitted && !samePollOptions(selected, submitted.selected) && Date.now() < submitted.expiresAt) return submitted.selected;
  if (submitted) state.pollSubmitted.delete(key);
  return selected;
}
function selectedPollOptions(message) {
  const key = pollKey(message);
  if (!state.pollDirty.has(key) || !state.pollSelections.has(key)) state.pollSelections.set(key, new Set(recordedPollOptions(message)));
  return state.pollSelections.get(key);
}
function updatePollControls() {
  for (const bubble of $('messages').querySelectorAll('.message[data-message-id]')) {
    const message = state.messages.find(item => String(item.id) === bubble.dataset.messageId);
    if (!message || message.metadata?.kind !== 'poll' || message.metadata?.results?.available !== true) continue;
    const selected = selectedPollOptions(message);
    const recorded = recordedPollOptions(message);
    const busy = state.pollBusy.has(pollKey(message));
    for (const option of bubble.querySelectorAll('button.message-poll-option')) {
      const active = selected.has(Number(option.dataset.pollOptionIndex));
      option.classList.toggle('is-selected', active);
      option.setAttribute('aria-pressed', String(active));
      option.disabled = busy;
    }
    const submit = bubble.querySelector('.message-poll-submit');
    const changed = selected.size !== recorded.size || [...selected].some(index => !recorded.has(index));
    if (submit) {
      submit.disabled = busy || !changed;
      submit.textContent = busy ? 'Enviando…' : !selected.size && recorded.size ? 'Retirar voto' : recorded.size ? 'Cambiar voto' : 'Votar';
    }
  }
}
function renderMessages() {
  if (!state.chat || !messageRenderer) return;
  const pane = $('messages');
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100;
  const oldTop = pane.scrollTop;
  const first = !state.signature;
  const remote = state.messages;
  const pending = visibleOutgoingMessages(remote, outgoingFor(state.account, state.chat));
  // QA #113: el pendiente se pintaba sin adjunto (la proyección no llevaba attachments).
  // Ahora la tarjeta «Enviando…» del renderer muestra el nombre; el texto del pie no
  // duplica el nombre (antes caía a item.file.name como texto).
  // QA 22-10: sort con compareMessages — un pendiente/fallido del outbox no debe quedar colgado
  // por debajo de mensajes posteriores (se añadía al final sin mirar su timestamp).
  const visible = remote.concat(pending.map(item => ({id: item.id, text: item.text || '', fromMe: true, timestamp: item.timestamp, replyToMessageId: item.replyTo || null, ...(item.file || item.fileName ? {attachments: [{name: item.file?.name || item.fileName, mimeType: item.file?.type || '', size: item.file?.size, pending: true}]} : {})}))).sort(compareMessages);
  const signature = JSON.stringify([visible, pending.map(item => [item.id, item.state])]);
  if (signature === state.signature) return;
  state.signature = signature;
  if (!visible.length) pane.replaceChildren(node('div', 'welcome', 'No hay mensajes sincronizados en esta conversación.'));
  else messageRenderer.reconcileMessageList(pane, visible, {
    showSenderNames: state.selectedChat?.isGroup === true,
    onImageOpen: ({url, name, document: documentRef, opener}) => {
      const ctx = context();
      messageRenderer.openImageViewer(url, name, documentRef, opener, async cursor => {
        if (!current(ctx)) return null;
        const page = await api(query('/api/chats/media', {chat: ctx.chat, kind: 'image', limit: '200', ...(cursor ? {cursor} : {})}), undefined, undefined, AbortSignal.timeout(30000));
        return current(ctx) && page.account === ctx.account && page.chat === ctx.chat ? page : null;
      });
    },
  });
  updatePollControls();
  for (const item of pending) {
    const bubble = [...pane.querySelectorAll('.message[data-message-id]')].find(element => element.dataset.messageId === item.id);
    if (!bubble) continue;
    bubble.dataset.sendState = item.state;
    if (item.state === 'confirmed') bubble.removeAttribute('aria-label');
    else bubble.setAttribute('aria-label', item.state === 'failed' ? 'Mensaje sin confirmar' : 'Enviando mensaje');
    const meta = bubble.querySelector('.message-meta') || bubble.appendChild(node('div', 'message-meta'));
    meta.querySelectorAll('.message-send-feedback, .message-restore, .message-reply-warning, .message-file-warning, .message-view-once').forEach(element => element.remove());
    if (item.viewOnce) meta.append(node('span', 'message-view-once', 'Ver una vez'));
    // Jordi 22-10: sin texto «Enviando…/Entrega no confirmada»: el glifo del CSS (reloj/⚠)
    // basta; el estado va en el aria-label de la burbuja, puesto arriba.
    if (item.state !== 'confirmed') {
      const feedback = node('span', 'message-send-feedback', '');
      feedback.setAttribute('aria-hidden', 'true');
      meta.append(feedback);
    }
    if (item.state === 'failed') {
      if (item.replyTo) meta.append(node('span', 'message-reply-warning', 'La cita se recuperará al editar si sigue disponible.'));
      if (item.fileName && !item.file) meta.append(node('span', 'message-file-warning', item.viewOnce ? 'Adjunta el archivo y activa Ver una vez de nuevo.' : 'Adjunta el archivo de nuevo.'));
      const restore = node('button', 'message-restore', 'Editar texto');
      restore.type = 'button';
      restore.onclick = () => {
        if (item.file && pendingFiles.length) { error('Retira los adjuntos actuales antes de recuperar este mensaje.'); return; }
        const composer = $('message');
        composer.value = composer.value ? `${composer.value}\n${item.text}` : item.text;
        if (item.file && !pendingFiles.length) stageAttachment(item.file, item.viewOnce === true);
        if (item.fileName && !item.file) error(`Texto recuperado. Adjunta ${item.fileName} de nuevo antes de enviarlo.`);
        if (item.replyTo && !featureUI?.restoreReply?.(item.replyTo)) error('Texto recuperado. Vuelve a seleccionar la cita original antes de enviarlo.');
        saveDraft();
        composer.focus();
        state.outgoing.set(outgoingKey(item.account, item.chat), outgoingFor(item.account, item.chat).filter(entry => entry !== item));
        persistOutbox();
        state.signature = '';
        renderMessages();
      };
      meta.append(restore);
      if (item.sendToken && (item.file || !item.fileName)) {
        const retry = node('button', 'message-restore', 'Reintentar el mismo envío');
        retry.type = 'button';
        retry.onclick = () => {
          if (item.state !== 'failed') return;
          item.ctx = context();
          item.knownIds = new Set(state.messages.map(message => String(message.waMessageId || message.id)));
          item.state = 'sending';
          persistOutbox();
          state.signature = '';
          renderMessages();
          const replyTo = item.replyTo || '';
          if (item.file) void sendOptimistic(item, '/api/upload', async () => attachmentTools.uploadPayload(item.file, await base64(item.file), item.caption || '', replyTo, item.quality, item.viewOnce));
          else void sendOptimistic(item, replyTo ? '/api/messages/reply' : '/api/send', {text: item.text, ...(replyTo ? {replyTo, messageId: replyTo} : {})});
        };
        meta.append(retry);
      }
    }
  }
  pane.scrollTop = first || atBottom ? pane.scrollHeight : oldTop;
  // UX #58.1: al abrir el primer chat el scroll-al-final corría antes de que el
  // navegador asentara el layout (scrollHeight aún pequeño) y quedabas arriba.
  // Se re-ancla al fondo en el siguiente frame si el usuario no ha subido.
  if (first) requestAnimationFrame(() => {
    if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100) pane.scrollTop = pane.scrollHeight;
  });
}
$('messages').addEventListener('click', async event => {
  const option = event.target.closest?.('button.message-poll-option');
  const submit = event.target.closest?.('button.message-poll-submit');
  if (!option && !submit) return;
  const bubble = event.target.closest('.message[data-message-id]');
  const message = state.messages.find(item => String(item.id) === bubble?.dataset.messageId);
  if (!message || message.metadata?.kind !== 'poll' || message.metadata?.results?.available !== true) return;
  const key = pollKey(message);
  if (state.pollBusy.has(key)) return;
  const selected = selectedPollOptions(message);
  if (option) {
    const index = Number(option.dataset.pollOptionIndex);
    const names = message.metadata.options || [];
    if (!Number.isInteger(index) || index < 0 || index >= names.length) return;
    if (selected.has(index)) selected.delete(index);
    else {
      const max = Number(message.metadata.selectableCount) > 0 ? Number(message.metadata.selectableCount) : names.length;
      if (max === 1) selected.clear();
      else if (selected.size >= max) { error(`Puedes elegir hasta ${max} opciones.`); return; }
      selected.add(index);
    }
    if (samePollOptions(selected, recordedPollOptions(message))) state.pollDirty.delete(key);
    else state.pollDirty.add(key);
    error();
    updatePollControls();
    return;
  }
  const ctx = context();
  const recorded = recordedPollOptions(message);
  if (samePollOptions(selected, recorded)) return;
  const options = [...selected].map(index => message.metadata.options[index]);
  const signature = JSON.stringify(options);
  let attempt = state.pollAttempts.get(key);
  if (!attempt || attempt.signature !== signature) {
    attempt = {signature, token: crypto.randomUUID()};
    state.pollAttempts.set(key, attempt);
  }
  state.pollBusy.add(key);
  updatePollControls();
  try {
    await api('/api/messages/poll/vote', {account: ctx.account, chat: ctx.chat, messageId: message.id,
      options, sendToken: attempt.token});
    const submitted = {selected: new Set(selected), expiresAt: Date.now() + 15000};
    state.pollSubmitted.set(key, submitted);
    state.pollSelections.set(key, new Set(selected));
    state.pollDirty.delete(key);
    state.pollAttempts.delete(key);
    setTimeout(() => {
      if (state.pollSubmitted.get(key) !== submitted) return;
      state.pollSubmitted.delete(key);
      if (state.account === ctx.account && state.chat === ctx.chat) updatePollControls();
    }, 15000);
    if (current(ctx)) await loadMessages();
  } catch (err) { if (current(ctx)) error(err.message); }
  finally { state.pollBusy.delete(key); if (current(ctx)) updatePollControls(); }
});
// QA velocidad #98: con F5 el chat se volvía a bajar entero (4,4 s en frío, no-store).
// Se pinta la última página conocida y se revalida, como ya hace la lista de chats.
const messageCacheKey = (account, chat) => `wa:msgs:${account}:${chat}`;
function paintCachedMessages(ctx) {
  if (state.messages.length) return;
  try {
    const cached = JSON.parse(localStorage.getItem(messageCacheKey(ctx.account, ctx.chat)) || 'null');
    if (Array.isArray(cached) && cached.length) { state.messages = cached; renderMessages(); }
  } catch { /* caché rota: se revalida como si no hubiera caché */ }
}
async function loadMessages() {
  if (!state.chat || state.historyMode) return;
  const ctx = context();
  const requestToken = ++state.messageRequestToken;
  try {
    await rendererReady;
    paintCachedMessages(ctx);
    const result = await api(query('/api/messages', {chat: ctx.chat, limit: 100}));
    if (!current(ctx) || state.historyMode || requestToken !== state.messageRequestToken) return;
    const messages = Array.isArray(result.messages) ? result.messages : [];
    state.messages = mergeRecentMessages(state.messages, messages);
    try { localStorage.setItem(messageCacheKey(ctx.account, ctx.chat), JSON.stringify(messages)); } catch { /* cuota llena: la caché es lo mejor */ }
    if (!state.historyInitialized) {
      state.historyCursor = result.nextCursor || null;
      state.historyInitialized = true;
      updateOlderControl();
    }
    const key = outgoingKey(ctx.account, ctx.chat);
    const remaining = outgoingFor(ctx.account, ctx.chat).filter(item => !state.messages.some(message => matchesConfirmedMessage(item, message)));
    state.outgoing.set(key, remaining);
    persistOutbox();
    renderMessages();
    historyNotice.hidden = true;
    featureUI?.messagesChanged?.(state.messages);
    updateRecoveryNotice();
    if (needsMessageRecovery(state.messages)) void recoverMessages(ctx);
  } catch (err) { if (current(ctx) && requestToken === state.messageRequestToken) error(err.message); }
}
async function loadOlderMessages() {
  if (!state.chat || !state.historyCursor || state.loadingOlder) return;
  const ctx = context();
  const cursor = state.historyCursor;
  state.loadingOlder = true;
  updateOlderControl();
  try {
    const result = await api(query('/api/messages', {chat: ctx.chat, before: cursor, limit: 100}));
    if (!current(ctx) || cursor !== state.historyCursor) return;
    const pane = $('messages');
    const previousHeight = pane.scrollHeight;
    const previousTop = pane.scrollTop;
    state.messages = mergeMessages(state.messages, Array.isArray(result.messages) ? result.messages : []);
    state.historyCursor = result.nextCursor || null;
    renderMessages();
    pane.scrollTop = previousTop + pane.scrollHeight - previousHeight;
    featureUI?.messagesChanged?.(state.messages);
    error();
  } catch (err) { if (current(ctx) && cursor === state.historyCursor) error(err.message); }
  finally { if (current(ctx)) { state.loadingOlder = false; updateOlderControl(); } }
}
async function showHistoricalMessage(messageId) {
  const ctx = context();
  const requestToken = ++state.messageRequestToken;
  state.historyMode = true;
  try {
    const result = await api(query('/api/messages/around', {chat: ctx.chat, messageId}));
    if (!current(ctx) || requestToken !== state.messageRequestToken) return false;
    const messages = Array.isArray(result.messages) ? result.messages : [];
    const targetId = String(result.targetMessageId || messageId);
    const target = messages.find(message => [message.id, message.waMessageId].some(id => String(id) === targetId || String(id) === String(messageId)));
    if (!target) throw new Error('El mensaje ya no está disponible en esta conversación.');
    state.messages = messages;
    state.historyCursor = messages[0]?.id || null;
    state.historyInitialized = true;
    updateOlderControl();
    state.signature = '';
    renderMessages();
    historyNotice.hidden = false;
    featureUI?.messagesChanged?.(messages);
    const bubble = [...$('messages').querySelectorAll('[data-message-id]')].find(element => element.dataset.messageId === String(target.id));
    if (!bubble) throw new Error('No se pudo mostrar el mensaje encontrado.');
    bubble.tabIndex = -1;
    bubble.classList.add('message-highlight');
    bubble.focus({preventScroll: true});
    bubble.scrollIntoView({block: 'center'});
    return true;
  } catch (err) {
    // QA #73: loadMessages() sube el token y el guard se quedaba atrás → el
    // «Cargando mensajes…» de aquí no lo sustituía nunca la respuesta.
    if (current(ctx) && requestToken === state.messageRequestToken) {
      state.historyMode = false; historyNotice.hidden = true; resetMessageHistory();
      ++state.messageRequestToken;
      $('messages').replaceChildren(node('div', 'welcome', 'Cargando mensajes…')); void loadMessages();
    }
    throw err;
  }
}
function resizeMessageInput() {
  const input = $('message');
  input.style.height = 'auto';
  const maxHeight = parseFloat(getComputedStyle(input).maxHeight);
  const height = Math.min(input.scrollHeight, Number.isFinite(maxHeight) ? maxHeight : input.scrollHeight);
  input.style.height = `${height}px`;
  input.style.overflowY = input.scrollHeight > height ? 'auto' : 'hidden';
}
// QA #60: el límite del servidor (20000) devolvía un 400 lejos del foco; el contador avisa antes.
// Va en JS y no en index.html porque el shell está bajo contrato (http.whatsapp-app.favicon.v1).
$('message').maxLength = 20000;
const charCount = node('small', ''); charCount.id = 'char-count'; charCount.hidden = true;
document.querySelector('.message-input').append(charCount);
function saveDraft() {
  resizeMessageInput();
  const length = $('message').value.length;
  const counter = $('char-count');
  if (counter) { counter.hidden = length < 19000; counter.textContent = `${length}/20000`; }
  if (state.chat) state.drafts.set(`${state.account}:${state.chat}`, $('message').value);
}
function setAgentContext(chat = null) { $('ai-panel-subtitle').textContent = chat ? (chat.name || chat.id) : 'Selecciona un chat para consultar'; }
function applyDraft(text, ctx) {
  if (!current(ctx)) return false;
  const draft = draftTools?.normalizeDraftText(text) || text || '';
  const composer = $('message');
  composer.value = composer.value.trim() && draft ? `${composer.value}\n\n${draft}` : draft;
  saveDraft();
  $('message').focus();
  return true;
}
async function proposeMessage() {
  if (state.suggesting || !state.account || !state.chat) return;
  const ctx = context();
  state.suggesting = true;
  error();
  updateControls();
  try {
    const [tools] = await Promise.all([draftReady, assistantReady]);
    if (!assistant) return;
    const answer = await assistant.proposeDraft(tools.DRAFT_INSTRUCTION);
    const draft = tools.normalizeDraftText(answer);
    if (!current(ctx)) return;
    if (!draft) { error('Social Media Agent no devolvió un mensaje para proponer.'); return; }
    applyDraft(draft, ctx);
  } catch (err) {
    if (current(ctx)) error(err.message);
  } finally {
    state.suggesting = false;
    updateControls();
  }
}
function mobileChatEntry() { return history.state?.socialMediaChat === true; }
if (mobileChatEntry()) history.replaceState({...history.state, socialMediaChat: false}, '');
function restoreLastChat() {
  // QA 22-10 (#162): F5 caía en «Selecciona un chat» y volvía a bajar toda la lista.
  let lastId = null;
  try { lastId = localStorage.getItem(`wa:lastChat:${state.account}`); } catch {}
  if (!lastId) return;
  const chat = state.chats.find(item => item.id === lastId);
  if (chat) void selectChat(chat, { fromHistory: true });
}
function closeMobileChat() {
  messageRenderer?.closeMediaViewer?.(); cancelRecording(); cameraController?.close();
  document.body.classList.remove('chat-open');
  // QA 22-10 (#162): volver a la lista es salir del chat; si no, F5 lo reabriría.
  try { localStorage.removeItem(`wa:lastChat:${state.account}`); } catch {}
}
function selectChat(chat, {fromHistory = false, focusComposer = false} = {}) {
  messageRenderer?.closeMediaViewer?.(); saveDraft(); cancelRecording(); cameraController?.close(); cancelAttachment(); state.selectedChat = chat; state.chat = chat.id; state.historyMode = false; historyNotice.hidden = true; state.version++; resetMessageHistory(); state.signature = ''; $('message').value = state.drafts.get(`${state.account}:${state.chat}`) || ''; resizeMessageInput(); $('chat-title').textContent = chat.name || chat.id;
  // UX #2.4: sin dato real de estado no hay subtítulo; «Contacto» fijo no lo
  // tiene nadie en WhatsApp. Los grupos conservan «Grupo» (es verificable).
  $('chat-subtitle').textContent = chat.isGroup === true ? 'Grupo' : '';
  $('chat-subtitle').hidden = chat.isGroup !== true; setConversationAvatar(chat); setAgentContext(chat); $('messages').replaceChildren(node('div', 'welcome', 'Cargando mensajes…')); renderMessages(); assistant?.select(context()); document.body.classList.add('chat-open'); error(); featureUI?.chatChanged?.(chat); renderChats(); updateControls();
  // QA 22-10 (#162): F5 perdía el chat abierto (no estaba ni en localStorage ni en la URL).
  try { localStorage.setItem(`wa:lastChat:${state.account}`, chat.id); } catch {}
  if (!fromHistory && matchMedia('(max-width: 760px), (max-width: 1024px) and (max-height: 500px) and (pointer: coarse)').matches) {
    const entry = {...(typeof history.state === 'object' && history.state || {}), socialMediaChat: true, account: state.account, chat: state.chat};
    if (mobileChatEntry()) history.replaceState(entry, '');
    else history.pushState(entry, '');
  }
  // QA #75: con Enter en la fila el foco se quedaba en la fila; el teclado
  // esperaba un tab más para poder escribir.
  if (focusComposer) $('message').focus();
  return loadMessages();
}
window.addEventListener('popstate', event => {
  const entry = event.state;
  if (entry?.socialMediaChat === true && entry.account === state.account) {
    if (entry.chat === state.chat) document.body.classList.add('chat-open');
    else {
      const chat = state.chats.find(item => item.id === entry.chat);
      if (chat) void selectChat(chat, {fromHistory: true});
      else closeMobileChat();
    }
  } else closeMobileChat();
});
let sidebarSearch = null;
let uploadQualityUI = null;
const uploadQualityReady = import('./upload-quality-ui.mjs').then(({installUploadQualityUI}) => {
  uploadQualityUI = installUploadQualityUI(document, safeLocalStorage());
  return uploadQualityUI;
}).catch(err => { error(`No se pudo cargar la calidad de subida: ${err.message}`); return null; });
const sidebarSearchReady = import('./sidebar-search.mjs').then(({installSidebarMessageSearch}) => { sidebarSearch = installSidebarMessageSearch({
  documentRef: document, input: $('search'), chatList: $('chats'),
  getAccount: () => state.account, getChats: () => state.chats,
  request: ({account, query: term, cursor, signal}) => api(`/api/search?${new URLSearchParams({account, q: term, scope: 'all', limit: '50', ...(cursor ? {cursor} : {})})}`, undefined, undefined, signal),
  openMessage: async (chat, messageId, account) => {
    if (state.account !== account) return;
    const loading = selectChat(chat);
    const selected = context();
    await loading;
    if (current(selected)) {
      try { await showHistoricalMessage(messageId); }
      catch (err) { if (current(selected)) throw err; }
    }
  },
  showError: error,
}); return sidebarSearch; }).catch(err => { error(`No se pudo cargar la b\u00fasqueda: ${err.message}`); return null; });
// UX #9.5: renderChats reconstruye ~720 filas pesadas; sin debounce cada tecla
// la pagaba entera (hielo medido de ~25 s). La pausa de 150 ms basta.
let searchRenderTimer = null;
$('search').oninput = () => { clearTimeout(searchRenderTimer); searchRenderTimer = setTimeout(renderChats, 150); sidebarSearch?.changed(); }; $('message').oninput = saveDraft; $('back').onclick = () => {
  if (mobileChatEntry()) history.back();
  else closeMobileChat();
};
async function switchAccount(accountId) {
  if (!accountId || accountId === state.account || ![...$('account').options].some(option => option.value === accountId)) return;
  const settings = document.querySelector('.rail-settings');
  if (settings) settings.open = false;
  messageRenderer?.closeMediaViewer?.(); saveDraft(); cancelRecording(); cameraController?.close(); cancelAttachment();
  state.account = accountId; $('account').value = accountId; accountRailTools?.markActiveAccount($('account-rail'), accountId);
  // QA #18: el stream se reabre YA, no detrás de `await loadChats()`. Con el
  // listado de chats de personal lento (statement_timeout), esperar dejaba la
  // cuenta sin live updates hasta que resolvía el listado. start() cierra el
  // stream anterior igual que stop(); el refresh de fondo se deduplica con la
  // carga en curso (loadChats background + state.chatLoading).
  liveUpdates?.start(accountId);
  if (mobileChatEntry()) history.replaceState({...history.state, socialMediaChat: false}, '');
  state.chat = ''; state.historyMode = false; historyNotice.hidden = true; state.selectedChat = null; state.version++; resetMessageHistory(); state.chats = []; state.signature = '';
  $('message').value = ''; resizeMessageInput(); $('chat-title').textContent = 'SocialMedia'; $('chat-subtitle').textContent = 'Selecciona un chat para empezar'; $('chat-subtitle').hidden = false; setConversationAvatar(); setAgentContext();
  $('messages').replaceChildren(node('div', 'welcome', 'Selecciona una conversación de esta cuenta.'));
  assistant?.select(context());
  document.body.classList.remove('chat-open'); sidebarSearch?.accountChanged(); uploadQualityUI?.accountChanged(); featureUI?.accountChanged?.(state.account); communitiesUI?.accountChanged?.(); profileUI?.accountChanged?.(); mediaLibraryUI?.accountChanged?.(); novedadesUI?.accountChanged?.(); error(); renderChats(); updateControls(); await loadChats();
}
$('account').onchange = () => switchAccount($('account').value);
async function sendPayload(path, payload, onSuccess, onConfirmed) { const ctx = context(); state.busy = true; error(); updateControls(); try { const body = typeof payload === 'function' ? await payload() : payload; if (!current(ctx)) return; await api(path, {...ctx, version: undefined, ...body}); onConfirmed?.(ctx); if (current(ctx)) { onSuccess?.(ctx); await Promise.all([loadMessages(), loadChats()]); } } catch (err) { if (current(ctx)) error(err.message); } finally { state.busy = false; updateControls(); } }
async function sendOptimistic(item, path, payload) {
  let result;
  try {
    const body = typeof payload === 'function' ? await payload() : payload;
    result = await api(path, {account: item.account, chat: item.chat, ...body, sendToken: item.sendToken});
    if (!result.messageId) throw new Error('El servidor no confirmó el identificador del mensaje.');
  } catch (err) {
    // QA 22-10: un 4xx de validación es determinista — no se envió nada. La burbuja
    // optimista mentía («Entrega no confirmada») y el aviso de resultado incierto
    // era falso. Fuera la burbuja y el texto vuelve al composer (sin adjuntos: esos
    // conservan el flujo failed con «Adjunta de nuevo»).
    if (err.status >= 400 && err.status < 500 && err.status !== 401 && err.outcomeUncertain !== true && !item.file && !item.fileName) {
      state.outgoing.set(outgoingKey(item.account, item.chat), outgoingFor(item.account, item.chat).filter(entry => entry !== item));
      persistOutbox();
      if (current(item.ctx)) {
        const composer = $('message');
        composer.value = composer.value ? `${composer.value}\n${item.text}` : item.text;
        resizeMessageInput(); saveDraft();
        if (item.replyTo) featureUI?.restoreReply?.(item.replyTo);
        error(err.message);
        state.signature = '';
        renderMessages();
      }
      return false;
    }
    item.state = 'failed';
    persistOutbox();
    if (current(item.ctx)) {
      const uncertain = !err.status || err.status >= 500 || err.outcomeUncertain === true;
      error(uncertain && !err.message.includes('Comprueba') ? `${err.message} Comprueba si llegó antes de volver a enviarlo.` : err.message);
      state.signature = '';
      renderMessages();
    }
    return false;
  }
  item.messageId = result.messageId;
  item.state = 'confirmed';
  persistOutbox();
  if (current(item.ctx)) {
    state.signature = '';
    renderMessages();
    await Promise.all([loadMessages(), loadChats()]);
  }
  return true;
}
$('composer').onsubmit = event => {
  event.preventDefault();
  const text = $('message').value.trim();
  if ((!text && !pendingFiles.length) || !state.sending || !state.chat) return;
  if (state.historyMode) { state.historyMode = false; resetMessageHistory(); void loadMessages(); }
  const featurePayload = featureUI?.getSendPayload?.() || {};
  const ctx = context();
  const plans = pendingFiles.length
    ? mediaTools.planAttachmentSends(pendingFiles.map(entry => entry.file), text, featurePayload.replyTo)
    : [{text, replyTo: featurePayload.replyTo}];
  const viewOnceByFile = new Map(pendingFiles.map(entry => [entry.file, entry.viewOnce === true]));
  const items = plans.map(plan => ({id: `local-${crypto.randomUUID()}`, account: ctx.account, chat: ctx.chat, ctx,
    text: plan.text || plan.caption || '', caption: plan.caption || '', file: plan.file || null,
    viewOnce: plan.file ? viewOnceByFile.get(plan.file) === true : false,
    quality: plan.file ? attachmentTools.readUploadQuality(safeLocalStorage(), ctx.account, plan.file) : 'source',
    replyTo: plan.replyTo || '', sendToken: crypto.randomUUID(), timestamp: new Date().toISOString(), state: 'sending', messageId: null,
    knownIds: new Set(state.messages.map(message => String(message.waMessageId || message.id)))}));
  const key = outgoingKey(ctx.account, ctx.chat);
  state.outgoing.set(key, [...outgoingFor(ctx.account, ctx.chat), ...items]);
  persistOutbox();
  featureUI?.sendConfirmed?.();
  $('message').value = '';
  resizeMessageInput();
  state.drafts.delete(key);
  cancelAttachment();
  error();
  state.signature = '';
  renderMessages();
  $('message').focus();
  void sendPlannedMessages(items);
};
async function sendPlannedMessages(items) {
  // QA #122 (22-10): en serie, 3 fotos del mismo acto tardaban ~34 s (huecos de 23 s).
  // sendOptimistic no lanza (devuelve false), así que el Promise.all no traga errores.
  // shortcut: el orden de llegada puede barajarse; el orden garantizado es el álbum (#236).
  await Promise.all(items.map(async item => {
    if (item.file) {
      await sendOptimistic(item, '/api/upload', async () => attachmentTools.uploadPayload(item.file, await base64(item.file), item.caption, item.replyTo, item.quality, item.viewOnce));
    } else {
      const replyTo = item.replyTo;
      await sendOptimistic(item, replyTo ? '/api/messages/reply' : '/api/send', {text: item.text, ...(replyTo ? {replyTo, messageId: replyTo} : {})});
    }
  }));
}
function enterToSendEnabled() { return safeLocalStorage()?.getItem('wa-enter-to-send') !== 'false'; }
function updateMessageComposerHint(enabled = enterToSendEnabled()) {
  const message = $('message');
  const hint = enabled
    ? 'Enter para enviar · Shift+Enter para nueva línea'
    : 'Ctrl/Cmd+Enter para enviar · Enter para nueva línea';
  // UX #2.2: el placeholder es siempre «Escribe un mensaje» (como el móvil y
  // WhatsApp Web); las teclas van en el tooltip y la descripción accesible.
  message.placeholder = 'Escribe un mensaje';
  message.title = hint;
  message.setAttribute('aria-description', hint);
  message.enterKeyHint = enabled ? 'send' : 'enter';
}
updateMessageComposerHint();
document.addEventListener('wa:enter-to-send-change', event => updateMessageComposerHint(event.detail?.enabled ?? enterToSendEnabled()));
$('message').onkeydown = event => {
  if (event.keyCode !== 229 && shouldSubmitMessageKey(event, enterToSendEnabled())) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
};
// QA #111: escribir en árabe o hebreo debe empezar por la derecha, como en la oficial.
void rendererReady.then(({ detectDirection }) => {
  const composer = $('message');
  composer.addEventListener('input', () => { composer.dir = detectDirection(composer.value); });
});
function base64(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('No se pudo leer el archivo.')); reader.readAsDataURL(blob); }); }
let pendingFiles = [];
function renderStagedFiles() {
  const preview = $('attachment-preview');
  preview.replaceChildren();
  for (const [index, entry] of pendingFiles.entries()) {
    const card = node('div', 'composer-media-card');
    if (entry.previewUrl) {
      const thumbnail = node('img', 'composer-attachment-image');
      if (index === 0) thumbnail.id = 'attachment-thumbnail';
      thumbnail.alt = '';
      thumbnail.src = entry.previewUrl;
      card.append(thumbnail);
    }
    const label = node('span', 'composer-attachment-label', `${entry.file.name || 'Imagen pegada'} · ${(entry.file.size / 1024).toFixed(0)} KB`);
    if (index === 0) label.id = 'attachment-label';
    if (attachmentTools.canViewOnce(entry.file)) {
      const once = node('button', 'composer-view-once', 'Ver una vez');
      once.type = 'button';
      once.setAttribute('aria-label', `Ver una vez: ${entry.file.name || 'imagen'}`);
      once.setAttribute('aria-pressed', String(entry.viewOnce === true));
      once.onclick = () => {
        entry.viewOnce = !entry.viewOnce;
        once.setAttribute('aria-pressed', String(entry.viewOnce));
      };
      card.append(once);
    }
    const remove = node('button', 'composer-attachment-remove', 'Quitar');
    if (index === 0) remove.id = 'attachment-remove';
    remove.type = 'button';
    remove.setAttribute('aria-label', `Quitar ${entry.file.name || 'imagen'} del borrador`);
    remove.onclick = () => removeAttachment(entry.id);
    if (photoTools?.editableImage(entry.file)) {
      const edit = node('button', 'composer-attachment-edit', 'Editar');
      edit.type = 'button';
      edit.setAttribute('aria-label', `Editar ${entry.file.name || 'imagen'} antes de enviar`);
      edit.onclick = () => { error(); photoEditor?.open(entry.file, edited => applyPhotoEdit(entry, edited)); };
      card.append(edit);
    }
    card.append(label, remove);
    preview.append(card);
  }
  preview.hidden = !pendingFiles.length;
  $('composer').classList.toggle('has-attachment', pendingFiles.length > 0);
}
function removeAttachment(id) {
  const entry = pendingFiles.find(item => item.id === id);
  if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  pendingFiles = pendingFiles.filter(item => item.id !== id);
  renderStagedFiles();
}
function cancelAttachment() {
  for (const entry of pendingFiles) if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  pendingFiles = [];
  photoEditor?.close?.(false);
  renderStagedFiles();
}
function stageAttachment(file, viewOnce = false) {
  return stageSelectedFiles([file], viewOnce);
}
function stageSelectedFiles(files, viewOnce = false) {
  if (!state.chat || !state.sending || !attachmentTools || !files.length) return false;
  const rejected = [];
  for (const file of files) {
    const problem = attachmentTools.attachmentError(file);
    if (problem) { rejected.push(`${file?.name || 'Archivo'}: ${problem}`); continue; }
    pendingFiles.push({id: crypto.randomUUID(), file, viewOnce: viewOnce && attachmentTools.canViewOnce(file),
      previewUrl: file.type?.startsWith('image/') ? URL.createObjectURL(file) : ''});
  }
  renderStagedFiles();
  error(rejected.join(' '));
  if (pendingFiles.length) $('message').focus();
  return rejected.length === 0;
}
$('attach').onclick = () => $('attachment').click();
$('suggest').onclick = () => { void proposeMessage(); };
$('attachment').multiple = true;
// QA #91: el accept del diálogo era una lista cerrada de 6 tipos; el shell está bajo contrato, se abre desde JS.
$('attachment').accept = '';
$('attachment').onchange = () => { const files = [...$('attachment').files]; $('attachment').value = ''; stageSelectedFiles(files); };
document.addEventListener('paste', event => {
  if (!attachmentTools || !state.chat || !state.sending) return;
  const target = event.target;
  if (target !== $('message') && (target?.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target?.tagName))) return;
  const files = attachmentTools.filesFromClipboard(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  stageSelectedFiles(files);
});
const dropZone = document.querySelector('.conversation');
// QA #85 (menor): el drop funcionaba pero no había ninguna señal visual mientras arrastrabas.
dropZone?.addEventListener('dragover', event => {
  if (state.chat && state.sending && [...(event.dataTransfer?.types || [])].includes('Files')) {
    event.preventDefault();
    dropZone.classList.add('is-over');
  }
});
dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('is-over'));
dropZone?.addEventListener('drop', event => {
  dropZone.classList.remove('is-over');
  if (!state.chat || !state.sending) return;
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  stageSelectedFiles(files);
});

function stopRecordingTracks(stream) { if (messageRenderer?.stopMediaTracks) messageRenderer.stopMediaTracks(stream); else stream?.getTracks?.().forEach(track => track.stop()); }
function clearRecordingState() { state.stream = null; state.recorder = null; state.blob = null; state.recordingSendToken = null; if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl); state.recordingUrl = ''; $('recording-preview').removeAttribute('src'); $('recording-area').hidden = true; $('recording-preview').hidden = true; }
function cancelRecording() { state.recordingToken++; const recorder = state.recorder; if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch {} } stopRecordingTracks(state.stream); clearRecordingState(); }
$('record').onclick = async () => {
  if (state.busy || !state.sending || !state.chat) return;
  cancelRecording();
  const token = state.recordingToken;
  const ctx = context();
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio:true});
    if (!current(ctx) || token !== state.recordingToken) { stopRecordingTracks(stream); return; }
    const recorder = new MediaRecorder(stream);
    state.stream = stream;
    state.recorder = recorder;
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      stopRecordingTracks(stream);
      if (!current(ctx) || token !== state.recordingToken) return;
      state.blob = new Blob(chunks, {type:recorder.mimeType || 'audio/webm'});
      state.recordingUrl = URL.createObjectURL(state.blob);
      $('recording-preview').src = state.recordingUrl;
      $('recording-preview').hidden = false;
      $('recording-status').textContent = 'Escucha el audio antes de enviarlo.';
      $('recording-stop').hidden = true;
      $('recording-send').hidden = false;
    };
    recorder.onerror = () => { cancelRecording(); error('No se pudo grabar el audio.'); };
    recorder.start();
    $('recording-area').hidden = false;
    $('recording-status').textContent = 'Grabando…';
    $('recording-stop').hidden = false;
    $('recording-send').hidden = true;
  } catch (err) {
    const tokenIsCurrent = token === state.recordingToken;
    stopRecordingTracks(stream);
    if (tokenIsCurrent) state.recordingToken++;
    if (state.stream === stream) clearRecordingState();
    // QA #126 (22-10): el DOMException.message viene en inglés crudo (familia #76/#60);
    // el motivo se traduce por err.name y el texto del navegador nunca se interpola.
    if (current(ctx) && tokenIsCurrent) {
      const reasons = {NotFoundError: 'no hay ningún micrófono conectado.', NotAllowedError: 'permiso denegado.', NotReadableError: 'el micrófono está ocupado.'};
      error(`No se pudo acceder al micrófono: ${reasons[err?.name] || 'comprueba el micrófono del dispositivo.'}`);
    }
  }
};
$('recording-stop').onclick = () => { if (state.recorder?.state === 'recording') state.recorder.stop(); }; $('recording-cancel').onclick = cancelRecording; $('recording-send').onclick = async () => { if (!state.blob || state.busy || !state.sending) return; const ctx = context(); const blob = state.blob; const token = state.recordingToken; state.recordingSendToken ||= crypto.randomUUID(); try { const data = await base64(blob); if (!current(ctx) || token !== state.recordingToken) return; await sendPayload('/api/upload', {name:`nota-de-voz.${blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`,mimeType:blob.type,data,voice:true,sendToken:state.recordingSendToken}, cancelRecording); } catch (err) { if (current(ctx)) error(err.message); } };
function toggleAI(open) { $('ai-panel').hidden = !open; $('ai-toggle').setAttribute('aria-expanded', String(open)); if (open) closeRailPanels(['ai']); assistant?.setOpen(open); if (!open) $('ai-toggle').focus(); }
$('ai-toggle').onclick = () => toggleAI($('ai-panel').hidden); $('ai-close').onclick = () => toggleAI(false); document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('ai-panel').hidden) toggleAI(false); });
const featureReady = Promise.all([historyReady, mediaReady, photoEditorReady]).then(() => import('./features-ui.mjs')).then(({installFeatureUI}) => { featureUI = installFeatureUI({state, api, query, renderChats, loadChats, loadMessages, showHistoricalMessage, selectChat, getMessages: () => state.messages, getChats: () => state.chats, showError: error, isMessagePinned: id => pinnedUI?.has(id) === true, onPinsChange: () => pinnedUI?.refresh({force: true}), openCamera: () => state.sending ? cameraController?.open() : error('El envío está desactivado.'), openStickerEditor: (file, onApply) => photoEditor?.open(file, onApply, {mode: 'sticker'}), stageFiles: stageSelectedFiles, onOpen: () => closeRailPanels(['features', 'settings'])}); return featureUI; }).catch(err => { error(`No se pudo cargar la interfaz de funciones: ${err.message}`); return null; });
const chatSelectionReady = featureReady.then(() => import('./chat-selection.mjs')).then(({installChatSelection}) => installChatSelection({
  getScope: () => JSON.stringify([state.account, state.version, featureUI?.isFeatureView?.()]),
  getAccount: () => state.account, getChats: () => state.chats, canModify: () => state.sending,
  request: api, refresh: loadChats,
})).catch(err => { error(`No se pudo cargar la selección de chats: ${err.message}`); return null; });
const eventReady = import('./event-ui.mjs').then(({installEventUI}) => installEventUI({
  container: $('messages'), getContext: context, api, canSend: () => state.sending,
})).catch(err => { error(`No se pudieron cargar las respuestas a eventos: ${err.message}`); });
const pinnedReady = import('./pinned-ui.mjs').then(({installPinnedUI}) => {
  pinnedUI = installPinnedUI({messages: $('messages'), getContext: context, api, openMessage: showHistoricalMessage});
}).catch(err => { error(`No se pudieron cargar los mensajes fijados: ${err.message}`); });
// Los paneles del rail comparten viewport, foco y la tecla Escape: abrir uno debe cerrar los demás.
// `except` admite uno o varios nombres; los modales de features dejan abierto el popover de
// ajustes porque sus disparadores viven dentro, y cerrarlo dejaría el foco huérfano al volver.
function closeRailPanels(except = []) {
  const keep = new Set(Array.isArray(except) ? except : [except]);
  if (!keep.has('features')) featureUI?.closePanels?.();
  if (!keep.has('communities')) communitiesUI?.close?.();
  if (!keep.has('profile')) profileUI?.close?.();
  if (!keep.has('library')) mediaLibraryUI?.close?.();
  if (!keep.has('novedades')) novedadesUI?.close?.({restoreFocus: false});
  if (!keep.has('settings')) { const settings = document.querySelector('.rail-settings'); if (settings?.open) settings.open = false; }
  if (!keep.has('ai') && !$('ai-panel').hidden) toggleAI(false);
}
document.querySelector('.rail-settings')?.addEventListener('toggle', event => { if (event.target.open) closeRailPanels(['settings']); });
const communitiesReady = import('./communities-ui.mjs').then(({installCommunitiesUI}) => {
  communitiesUI = installCommunitiesUI({getAccount: () => state.account, api, selectChat, getChats: () => state.chats, showError: error, onOpen: () => closeRailPanels(['communities'])});
  return communitiesUI;
}).catch(err => { error(`No se pudo cargar Comunidades: ${err.message}`); return null; });
const profileReady = import('./profile-ui.mjs').then(({installProfileUI}) => { profileUI = installProfileUI({getAccount: () => state.account, api, onOpen: () => closeRailPanels(['profile'])}); return profileUI; }).catch(err => { error(`No se pudo cargar el perfil: ${err.message}`); return null; });
const novedadesReady = import('./novedades-ui.mjs').then(({installNovedadesUI}) => {
  const read = (path, fields = {}) => {
    const params = new URLSearchParams({account: state.account});
    for (const [key, value] of Object.entries(fields)) if (value != null && value !== '') params.set(key, value);
    return api(`${path}?${params}`);
  };
  novedadesUI = installNovedadesUI({
    getAccount: () => state.account,
    loadAuthors: () => read('/api/novedades/status/authors'),
    loadStatuses: (author, {cursor} = {}) => read('/api/novedades/status', {author, cursor}),
    loadChannels: ({cursor} = {}) => read('/api/novedades/channels', {cursor}),
    lookupChannel: query => read('/api/novedades/channels/lookup', {query}),
    changeChannelSubscription: (jid, action) => api('/api/novedades/channels/subscription', {account: state.account, jid, action}),
    loadPosts: (channel, {cursor} = {}) => read(`/api/novedades/channels/${encodeURIComponent(channel)}/posts`, {cursor}),
    loadContacts: ({q, cursor} = {}) => read('/api/contacts', {q, cursor, limit: '50'}),
    publishStatus: payload => api('/api/novedades/status', {...payload, account: state.account}, undefined, AbortSignal.timeout(90000)),
    canPublish: () => state.sending,
    onOpen: () => closeRailPanels(['novedades']),
  });
  for (const [id, tab] of [['statuses-open', 'statuses'], ['channels-open', 'channels']]) {
    const entry = $(id);
    entry.addEventListener('click', () => { if (state.account) novedadesUI?.open({opener: entry, tab}); });
    entry.disabled = false;
  }
  return novedadesUI;
}).catch(err => { error(`No se pudieron cargar las actualizaciones: ${err.message}`); return null; });
const mediaLibraryReady = import('./media-library-ui.mjs').then(({installMediaLibraryUI}) => {
  mediaLibraryUI = installMediaLibraryUI({getAccount: () => state.account, getChats: () => state.chats, api, selectChat: async chat => {
    const source = state.chats.find(item => item.id === chat.id) || { ...chat, isGroup: chat.id.endsWith('@g.us') };
    const selected = selectChat(source);
    const ctx = context();
    try {
      await selected;
      if (current(ctx) && chat.messageId) await showHistoricalMessage(chat.messageId);
    } catch (err) { if (current(ctx)) error(err.message); }
  }, onOpen: () => closeRailPanels(['library']) });
  return mediaLibraryUI;
}).catch(err => { error(`No se pudo cargar el contenido multimedia: ${err.message}`); return null; });
async function init() { try { await recoveryReady; await historyReady; await rendererReady; await attachmentReady; await mediaReady; await accountRailReady; await draftReady; await uploadQualityReady; await sidebarSearchReady; await featureReady; await chatSelectionReady; await eventReady; await pinnedReady; await communitiesReady; await profileReady; await mediaLibraryReady; await novedadesReady; await assistantReady; await liveReady; } catch (err) { error(`No se pudo cargar la interfaz de mensajes: ${err.message}`); return; } updateControls(); $('chat-status').textContent = 'Cargando cuentas…'; const result = await Promise.allSettled([api('/api/accounts')]); if (result[0].status === 'fulfilled') { const data = result[0].value; restoreOutbox(data.outboxScope); state.sending = data.sendingEnabled === true; for (const account of data.accounts || []) $('account').append(new Option(account.label || account.id, account.id)); state.account = $('account').value; sidebarSearch?.accountChanged(); uploadQualityUI?.accountChanged(); assistant?.select(context()); accountRailTools.renderAccountRail($('account-rail'), data.accounts || [], state.account, switchAccount); featureUI?.accountChanged?.(state.account); communitiesUI?.accountChanged?.(); profileUI?.accountChanged?.(); mediaLibraryUI?.accountChanged?.(); novedadesUI?.accountChanged?.(); updateControls(); if (state.account) { await loadChats(); liveUpdates?.start(state.account); restoreLastChat(); } else $('chat-status').textContent = 'No hay cuentas configuradas.'; } else { $('chat-status').textContent = 'No se pudieron cargar las cuentas.'; error(result[0].reason.message); } }
window.addEventListener('beforeunload', event => { if ([...state.outgoing.values()].flat().some(item => item.file && item.state !== 'confirmed')) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('click', event => { if (event.target.closest?.('a[href^="/auth/logout"]')) { try { sessionStorage.removeItem(OUTBOX_STORAGE_KEY); } catch {} } });
window.addEventListener('pagehide', () => { liveUpdates?.stop(); cancelRecording(); cameraController?.close(); cancelAttachment(); });
window.addEventListener('pageshow', event => { if (event.persisted && state.account) liveUpdates?.start(state.account); });
init();
