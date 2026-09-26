'use strict';
const $ = id => document.getElementById(id);
let messageRenderer = null;
const rendererReady = import('./message-render.mjs').then(module => { messageRenderer = module; return module; });
let attachmentTools = null;
const attachmentReady = import('./composer-attachment.mjs').then(module => { attachmentTools = module; return module; });
let accountRailTools = null;
const accountRailReady = import('./account-rail.mjs').then(module => { accountRailTools = module; return module; });
let draftTools = null;
const draftReady = import('./draft-suggest.mjs').then(module => { draftTools = module; return module; });
let assistant = null;
const assistantReady = draftReady.catch(() => null).then(() => import('./assistant-ui.js')).then(({mountAssistant}) => {
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
const state = {account: '', chat: '', chats: [], messages: [], historyMode: false, chatFilter: 'all', chatRequestToken: 0, messageRequestToken: 0, selectedChat: null, sending: false, version: 0, busy: false, suggesting: false, signature: '', drafts: new Map(), outgoing: new Map(), pollSelections: new Map(), pollBusy: new Set(), recorder: null, stream: null, blob: null, recordingUrl: '', recordingToken: 0, recordingSendToken: null};
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
const historyNotice = node('div', 'notice');
historyNotice.id = 'history-notice';
historyNotice.hidden = true;
historyNotice.append(node('span', '', 'Mostrando mensajes antiguos. '));
const showRecent = node('button', 'feature-button', 'Volver a recientes');
showRecent.type = 'button';
showRecent.onclick = () => { state.historyMode = false; loadMessages(); };
historyNotice.append(showRecent);
$('messages').before(historyNotice);
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
async function api(path, data, onEvent) {
  const signal = onEvent ? AbortSignal.timeout(240000) : undefined;
  const timeoutError = () => new Error('Se agotó el tiempo de espera del agente. Comprueba el chat antes de repetir una acción.');
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
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || `Error del servidor (${response.status}).`);
  return result;
}
function query(path, extra = {}) { return `${path}?${new URLSearchParams({account: state.account, ...extra})}`; }
function context() { return {account: state.account, chat: state.chat, version: state.version}; }
function current(ctx) { return ctx.version === state.version && ctx.account === state.account && ctx.chat === state.chat; }
function updateControls() { const disabled = !state.account || !state.chat || !state.sending; for (const id of ['message', 'attach', 'record', 'send']) $(id).disabled = disabled; const suggest = $('suggest'); suggest.disabled = !state.account || !state.chat || state.suggesting || state.busy; suggest.setAttribute('aria-busy', String(state.suggesting)); suggest.classList.toggle('is-busy', state.suggesting); $('attachment-remove').disabled = state.busy; $('record').disabled ||= state.busy || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder; $('sending-notice').hidden = state.sending; }
function setTheme(value) { const theme = value === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : value; document.body.dataset.theme = theme; try { localStorage.setItem('wa-theme', value); } catch {} }
try { const storedTheme = localStorage.getItem('wa-theme'); $('theme').value = ['dark', 'light', 'system'].includes(storedTheme) ? storedTheme : 'dark'; } catch { $('theme').value = 'dark'; }
setTheme($('theme').value); $('theme').onchange = () => setTheme($('theme').value); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTheme($('theme').value));
function chatFilterValue() { return state.chatFilter; }
function chatMatchesFilter(chat, filter) {
  if (featureUI?.matchesChat && !featureUI.matchesChat(chat, filter)) return false;
  if (filter === 'unread') return Number(chat.unread) > 0 || chat.unread === true;
  if (filter === 'groups') return chat.isGroup === true;
  return true;
}
function chatAvatar(chat) {
  const avatar = node('span', 'avatar');
  const url = messageRenderer?.safeMessageUrl(chat.avatarUrl || chat.avatar_url);
  if (url) { const image = node('img', 'chat-avatar-image'); image.src = url; image.alt = ''; image.loading = 'lazy'; image.onerror = () => { avatar.replaceChildren(); avatar.textContent = chatInitials(chat); }; avatar.append(image); }
  else avatar.textContent = chatInitials(chat);
  return avatar;
}
function chatInitials(chat) {
  const value = String(chat?.name || chat?.id || 'SocialMedia').trim();
  const parts = value.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || 'S').toLocaleUpperCase();
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
function renderChats() {
  const search = $('search').value.trim().toLocaleLowerCase();
  const filter = chatFilterValue();
  state.chatFilter = filter;
  const chats = state.chats.filter(chat => chatMatchesFilter(chat, filter) && `${chat.name || ''} ${chat.preview || ''}`.toLocaleLowerCase().includes(search));
  $('chat-count').textContent = String(state.chats.length);
  $('chats').replaceChildren();
  for (const chat of chats) {
    const button = node('button', `chat-item${chat.isGroup === true ? ' is-group' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-current', String(chat.id === state.chat));
    button.append(chatAvatar(chat));
    const details = node('span', 'chat-details');
    const nameRow = node('span', 'chat-name-row');
    nameRow.append(node('span', 'chat-name', chat.name || chat.id));
    if (chat.timestamp && messageRenderer) { const label = messageRenderer.formatChatListTime(chat.timestamp); if (label) { const time = node('time', 'chat-time', label); const date = new Date(typeof chat.timestamp === 'number' && chat.timestamp < 1e12 ? chat.timestamp * 1000 : chat.timestamp); if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString(); nameRow.append(time); } }
    details.append(nameRow, node('span', 'chat-preview', chat.preview || 'Sin mensajes disponibles'));
    button.append(details);
    if (Number(chat.unread) > 0 || chat.unread === true) button.append(node('span', 'badge', String(chat.unread === true ? '' : chat.unread)));
    button.onclick = () => selectChat(chat);
    $('chats').append(button);
  }
  $('chat-status').textContent = !state.chats.length ? (filter === 'archived' ? 'No hay chats archivados.' : 'Todavía no hay chats sincronizados para esta cuenta.') : !chats.length ? 'No hay conversaciones que coincidan.' : '';
}
async function loadChats() {
  if (!state.account) return;
  const account = state.account;
  const version = state.version;
  const requestToken = ++state.chatRequestToken;
  const archivedView = featureUI?.isFeatureView?.() === 'archived';
  try {
    const result = await api(query('/api/chats', archivedView ? {archived: 'only'} : {}));
    if (account !== state.account || version !== state.version || requestToken !== state.chatRequestToken || archivedView !== (featureUI?.isFeatureView?.() === 'archived')) return;
    state.chats = Array.isArray(result.chats) ? result.chats : [];
    featureUI?.chatsChanged?.(state.chats);
    renderChats();
  } catch (err) {
    if (account === state.account && version === state.version && requestToken === state.chatRequestToken) $('chat-status').textContent = err.message;
  }
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
    state:item.state, messageId:item.messageId, replyTo:item.replyTo, sendToken:item.sendToken, retryable:item.text.length <= 20000, fileName:item.file?.name || item.fileName || '',
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
      const item = {...entry, sendToken:entry.retryable !== false && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.sendToken || '') ? entry.sendToken : null, file:null, knownIds:new Set(), state:entry.state === 'confirmed' ? 'confirmed' : 'failed'};
      const key = outgoingKey(item.account, item.chat);
      state.outgoing.set(key, [...outgoingFor(item.account, item.chat), item]);
    }
    persistOutbox();
  } catch { try { sessionStorage.removeItem(OUTBOX_STORAGE_KEY); } catch {} }
}
function pollKey(message) { return `${state.account}:${state.chat}:${message.id}`; }
function selectedPollOptions(message) {
  const key = pollKey(message);
  if (!state.pollSelections.has(key)) {
    const selected = new Set();
    for (const [index, name] of (message.metadata?.options || []).entries()) {
      if (message.metadata?.results?.options?.find(option => option.name === name)?.selectedByMe) selected.add(index);
    }
    state.pollSelections.set(key, selected);
  }
  return state.pollSelections.get(key);
}
function updatePollControls() {
  for (const bubble of $('messages').querySelectorAll('.message[data-message-id]')) {
    const message = state.messages.find(item => String(item.id) === bubble.dataset.messageId);
    if (!message || message.metadata?.kind !== 'poll' || message.metadata?.results?.available !== true) continue;
    const selected = selectedPollOptions(message);
    const busy = state.pollBusy.has(pollKey(message));
    for (const option of bubble.querySelectorAll('button.message-poll-option')) {
      const active = selected.has(Number(option.dataset.pollOptionIndex));
      option.classList.toggle('is-selected', active);
      option.setAttribute('aria-pressed', String(active));
      option.disabled = busy;
    }
    const submit = bubble.querySelector('.message-poll-submit');
    if (submit) { submit.disabled = busy || selected.size === 0; submit.textContent = busy ? 'Enviando…' : 'Votar'; }
  }
}
function renderMessages() {
  if (!state.chat || !messageRenderer) return;
  const pane = $('messages');
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100;
  const oldTop = pane.scrollTop;
  const first = !state.signature;
  const remote = state.messages;
  const pending = outgoingFor(state.account, state.chat);
  const visible = remote.concat(pending.map(item => ({id: item.id, text: item.text || item.file?.name || item.fileName || '', fromMe: true, timestamp: item.timestamp, replyToMessageId: item.replyTo || null})));
  const signature = JSON.stringify([visible, pending.map(item => [item.id, item.state])]);
  if (signature === state.signature) return;
  state.signature = signature;
  if (!visible.length) pane.replaceChildren(node('div', 'welcome', 'No hay mensajes sincronizados en esta conversación.'));
  else messageRenderer.reconcileMessageList(pane, visible, {showSenderNames: state.selectedChat?.isGroup === true});
  updatePollControls();
  for (const item of pending) {
    const bubble = [...pane.querySelectorAll('.message[data-message-id]')].find(element => element.dataset.messageId === item.id);
    if (!bubble) continue;
    bubble.dataset.sendState = item.state;
    if (item.state === 'confirmed') bubble.removeAttribute('aria-label');
    else bubble.setAttribute('aria-label', item.state === 'failed' ? 'Mensaje sin confirmar' : 'Enviando mensaje');
    const meta = bubble.querySelector('.message-meta') || bubble.appendChild(node('div', 'message-meta'));
    meta.querySelectorAll('.message-send-feedback, .message-restore, .message-reply-warning, .message-file-warning').forEach(element => element.remove());
    if (item.state !== 'confirmed') meta.append(node('span', 'message-send-feedback', item.state === 'failed' ? 'Entrega no confirmada' : 'Enviando…'));
    if (item.state === 'failed') {
      if (item.replyTo) meta.append(node('span', 'message-reply-warning', ' · La cita se recuperará al editar si sigue disponible.'));
      if (item.fileName && !item.file) meta.append(node('span', 'message-file-warning', ' · Adjunta el archivo de nuevo.'));
      const restore = node('button', 'message-restore', 'Editar texto');
      restore.type = 'button';
      restore.onclick = () => {
        if (item.file && pendingFile) { error('Retira el adjunto actual antes de recuperar este mensaje.'); return; }
        const composer = $('message');
        composer.value = composer.value ? `${composer.value}\n${item.text}` : item.text;
        if (item.file && !pendingFile) stageAttachment(item.file);
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
      if (item.sendToken && !item.file && !item.fileName) {
        const retry = node('button', 'message-restore', 'Reintentar el mismo envío');
        retry.type = 'button';
        retry.onclick = () => {
          if (item.state !== 'failed') return;
          item.ctx = context();
          item.state = 'sending';
          persistOutbox();
          state.signature = '';
          renderMessages();
          const replyTo = item.replyTo || '';
          void sendOptimistic(item, replyTo ? '/api/messages/reply' : '/api/send', {text: item.text, ...(replyTo ? {replyTo, messageId: replyTo} : {})});
        };
        meta.append(retry);
      }
    }
  }
  pane.scrollTop = first || atBottom ? pane.scrollHeight : oldTop;
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
    error();
    updatePollControls();
    return;
  }
  if (!selected.size) return;
  const ctx = context();
  state.pollBusy.add(key);
  updatePollControls();
  try {
    await api('/api/messages/poll/vote', {account: ctx.account, chat: ctx.chat, messageId: message.id,
      options: [...selected].map(index => message.metadata.options[index])});
    state.pollSelections.delete(key);
    if (current(ctx)) await loadMessages();
  } catch (err) { if (current(ctx)) error(err.message); }
  finally { state.pollBusy.delete(key); if (current(ctx)) updatePollControls(); }
});
async function loadMessages() {
  if (!state.chat || state.historyMode) return;
  const ctx = context();
  const requestToken = ++state.messageRequestToken;
  try {
    await rendererReady;
    const result = await api(query('/api/messages', {chat: ctx.chat}));
    if (!current(ctx) || state.historyMode || requestToken !== state.messageRequestToken) return;
    const messages = Array.isArray(result.messages) ? result.messages : [];
    state.messages = messages;
    const key = outgoingKey(ctx.account, ctx.chat);
    const remaining = outgoingFor(ctx.account, ctx.chat).filter(item => !messages.some(message => matchesConfirmedMessage(item, message)));
    state.outgoing.set(key, remaining);
    persistOutbox();
    renderMessages();
    historyNotice.hidden = true;
    featureUI?.messagesChanged?.(messages);
  } catch (err) { if (current(ctx)) error(err.message); }
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
    state.signature = '';
    renderMessages();
    historyNotice.hidden = false;
    featureUI?.messagesChanged?.(messages);
    const bubble = [...$('messages').querySelectorAll('[data-message-id]')].find(element => element.dataset.messageId === String(target.id));
    if (!bubble) throw new Error('No se pudo mostrar el mensaje encontrado.');
    bubble.tabIndex = -1;
    bubble.focus({preventScroll: true});
    bubble.scrollIntoView({block: 'center'});
    return true;
  } catch (err) {
    if (current(ctx) && requestToken === state.messageRequestToken) { state.historyMode = false; void loadMessages(); }
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
function saveDraft() { resizeMessageInput(); if (state.chat) state.drafts.set(`${state.account}:${state.chat}`, $('message').value); }
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
function selectChat(chat) { messageRenderer?.closeMediaViewer?.(); saveDraft(); cancelRecording(); cancelAttachment(); state.selectedChat = chat; state.chat = chat.id; state.messages = []; state.historyMode = false; historyNotice.hidden = true; state.version++; state.signature = ''; $('message').value = state.drafts.get(`${state.account}:${state.chat}`) || ''; resizeMessageInput(); $('chat-title').textContent = chat.name || chat.id; $('chat-subtitle').textContent = chat.isGroup === true ? 'Grupo' : 'Contacto'; setConversationAvatar(chat); setAgentContext(chat); $('messages').replaceChildren(node('div', 'welcome', 'Cargando mensajes…')); renderMessages(); assistant?.select(context()); document.body.classList.add('chat-open'); error(); featureUI?.chatChanged?.(chat); renderChats(); updateControls(); return loadMessages(); }
$('search').oninput = renderChats; $('message').oninput = saveDraft; $('back').onclick = () => { messageRenderer?.closeMediaViewer?.(); cancelRecording(); document.body.classList.remove('chat-open'); };
async function switchAccount(accountId) {
  if (!accountId || accountId === state.account || ![...$('account').options].some(option => option.value === accountId)) return;
  messageRenderer?.closeMediaViewer?.(); saveDraft(); cancelRecording(); cancelAttachment();
  state.account = accountId; $('account').value = accountId; accountRailTools?.markActiveAccount($('account-rail'), accountId);
  state.chat = ''; state.messages = []; state.historyMode = false; historyNotice.hidden = true; state.selectedChat = null; state.version++; state.chats = []; state.signature = '';
  $('message').value = ''; resizeMessageInput(); $('chat-title').textContent = 'SocialMedia'; $('chat-subtitle').textContent = 'Selecciona un chat para empezar'; setConversationAvatar(); setAgentContext();
  $('messages').replaceChildren(node('div', 'welcome', 'Selecciona una conversación de esta cuenta.'));
  assistant?.select(context());
  document.body.classList.remove('chat-open'); featureUI?.accountChanged?.(state.account); error(); renderChats(); updateControls(); await loadChats();
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
    item.state = 'failed';
    persistOutbox();
    if (current(item.ctx)) {
      error(`${err.message} Comprueba si llegó antes de volver a enviarlo.`);
      state.signature = '';
      renderMessages();
    }
    return;
  }
  item.messageId = result.messageId;
  item.state = 'confirmed';
  persistOutbox();
  if (current(item.ctx)) {
    state.signature = '';
    renderMessages();
    await Promise.all([loadMessages(), loadChats()]);
  }
}
$('composer').onsubmit = event => {
  event.preventDefault();
  const text = $('message').value.trim();
  if ((!text && !pendingFile) || !state.sending || !state.chat) return;
  if (state.historyMode) { state.historyMode = false; void loadMessages(); }
  const featurePayload = featureUI?.getSendPayload?.() || {};
  const file = pendingFile?.file || null;
  if (file) {
    const problem = attachmentTools.attachmentCaptionError(file, text);
    if (problem) { error(problem); return; }
  }
  const ctx = context();
  const item = {id: `local-${crypto.randomUUID()}`, account: ctx.account, chat: ctx.chat, ctx, text, file, replyTo: featurePayload.replyTo, sendToken: crypto.randomUUID(), timestamp: new Date().toISOString(), state: 'sending', messageId: null};
  const key = outgoingKey(ctx.account, ctx.chat);
  state.outgoing.set(key, [...outgoingFor(ctx.account, ctx.chat), item]);
  persistOutbox();
  featureUI?.sendConfirmed?.();
  $('message').value = '';
  resizeMessageInput();
  state.drafts.delete(key);
  if (file) cancelAttachment();
  error();
  state.signature = '';
  renderMessages();
  $('message').focus();
  if (file) {
    sendOptimistic(item, '/api/upload', async () => attachmentTools.uploadPayload(file, await base64(file), text, featurePayload.replyTo));
    return;
  }
  sendOptimistic(item, featurePayload.replyTo ? '/api/messages/reply' : '/api/send', {text, ...featurePayload, ...(featurePayload.replyTo ? {messageId: featurePayload.replyTo} : {})});
};
$('message').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); $('composer').requestSubmit(); } };
function base64(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('No se pudo leer el archivo.')); reader.readAsDataURL(blob); }); }
let pendingFile = null;
let attachmentPreviewUrl = '';
function cancelAttachment() {
  pendingFile = null;
  if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
  attachmentPreviewUrl = '';
  $('attachment-thumbnail').removeAttribute('src');
  $('attachment-thumbnail').hidden = true;
  $('attachment-preview').hidden = true;
  $('composer').classList.remove('has-attachment');
}
function stageAttachment(file) {
  if (!file || !state.chat || !state.sending || state.busy) return;
  const problem = attachmentTools.attachmentError(file);
  if (problem) { error(problem); return; }
  cancelAttachment();
  pendingFile = {file, ctx: context()};
  $('attachment-label').textContent = `${file.name || 'Imagen pegada'} · ${(file.size / 1024).toFixed(0)} KB`;
  if (file.type?.startsWith('image/')) {
    attachmentPreviewUrl = URL.createObjectURL(file);
    $('attachment-thumbnail').src = attachmentPreviewUrl;
    $('attachment-thumbnail').hidden = false;
  }
  $('attachment-preview').hidden = false;
  $('composer').classList.add('has-attachment');
  error();
  $('message').focus();
}
function stageSelectedFiles(files) {
  if (files.length > 1) { error(`Solo se admite un adjunto por mensaje. No se añadió ninguno de los ${files.length} archivos; elige uno.`); return; }
  stageAttachment(files[0]);
}
$('attachment-remove').onclick = cancelAttachment;
$('attach').onclick = () => $('attachment').click();
$('suggest').onclick = () => { void proposeMessage(); };
$('attachment').multiple = true;
$('attachment').onchange = () => { const files = [...$('attachment').files]; $('attachment').value = ''; stageSelectedFiles(files); };
document.addEventListener('paste', event => {
  if (!attachmentTools || !state.chat || !state.sending || state.busy) return;
  const target = event.target;
  if (target !== $('message') && (target?.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target?.tagName))) return;
  const files = attachmentTools.filesFromClipboard(event.clipboardData);
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
    if (current(ctx) && tokenIsCurrent) error(`No se pudo acceder al micrófono: ${err.message}`);
  }
};
$('recording-stop').onclick = () => { if (state.recorder?.state === 'recording') state.recorder.stop(); }; $('recording-cancel').onclick = cancelRecording; $('recording-send').onclick = async () => { if (!state.blob || state.busy || !state.sending) return; const ctx = context(); const blob = state.blob; const token = state.recordingToken; state.recordingSendToken ||= crypto.randomUUID(); try { const data = await base64(blob); if (!current(ctx) || token !== state.recordingToken) return; await sendPayload('/api/upload', {name:`nota-de-voz.${blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`,mimeType:blob.type,data,voice:true,sendToken:state.recordingSendToken}, cancelRecording); } catch (err) { if (current(ctx)) error(err.message); } };
function toggleAI(open) { $('ai-panel').hidden = !open; $('ai-toggle').setAttribute('aria-expanded', String(open)); assistant?.setOpen(open); if (!open) $('ai-toggle').focus(); }
$('ai-toggle').onclick = () => toggleAI($('ai-panel').hidden); $('ai-close').onclick = () => toggleAI(false); document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('ai-panel').hidden) toggleAI(false); });
const featureReady = import('./features-ui.mjs').then(({installFeatureUI}) => { featureUI = installFeatureUI({state, api, query, renderChats, loadChats, loadMessages, showHistoricalMessage, selectChat, getMessages: () => state.messages, getChats: () => state.chats, showError: error}); return featureUI; }).catch(err => { error(`No se pudo cargar la interfaz de funciones: ${err.message}`); return null; });
async function init() { try { await rendererReady; await attachmentReady; await accountRailReady; await draftReady; await featureReady; await assistantReady; } catch (err) { error(`No se pudo cargar la interfaz de mensajes: ${err.message}`); return; } updateControls(); $('chat-status').textContent = 'Cargando cuentas…'; const result = await Promise.allSettled([api('/api/accounts')]); if (result[0].status === 'fulfilled') { const data = result[0].value; restoreOutbox(data.outboxScope); state.sending = data.sendingEnabled === true; for (const account of data.accounts || []) $('account').append(new Option(account.label || account.id, account.id)); state.account = $('account').value; assistant?.select(context()); accountRailTools.renderAccountRail($('account-rail'), data.accounts || [], state.account, switchAccount); featureUI?.accountChanged?.(state.account); updateControls(); if (state.account) await loadChats(); else $('chat-status').textContent = 'No hay cuentas configuradas.'; } else { $('chat-status').textContent = 'No se pudieron cargar las cuentas.'; error(result[0].reason.message); } }
let polling = false; setInterval(async () => { if (polling) return; polling = true; try { await loadChats(); if (!document.hidden) await loadMessages(); } finally { polling = false; } }, 10000);
window.addEventListener('beforeunload', event => { if ([...state.outgoing.values()].flat().some(item => item.file && item.state !== 'confirmed')) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('click', event => { if (event.target.closest?.('a[href^="/auth/logout"]')) { try { sessionStorage.removeItem(OUTBOX_STORAGE_KEY); } catch {} } });
window.addEventListener('pagehide', () => { cancelRecording(); cancelAttachment(); });
init();
