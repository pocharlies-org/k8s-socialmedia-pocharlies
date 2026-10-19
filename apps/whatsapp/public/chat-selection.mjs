const ACTIONS = new Set(['read', 'unread', 'archive', 'unarchive', 'mute', 'unmute']);

export async function applyChatBatch({ account, ids, action, request, isCurrent, onResult = () => {} }) {
  if (!account || !ACTIONS.has(action)) throw new Error('Acción de conversaciones no válida.');
  const results = [];
  for (const chat of [...new Set(ids)]) {
    if (!isCurrent()) break;
    try {
      const result = await request('/api/chat-actions', { account, chat, action });
      if (result?.account !== account || result?.chat !== chat || result?.confirmed !== true) throw new Error('La acción no quedó confirmada.');
      results.push({ chat, ok: true });
    } catch (error) { results.push({ chat, ok: false, error: error.message || 'No se pudo aplicar la acción.' }); }
    if (isCurrent()) onResult(results.at(-1), results.length);
  }
  return results;
}

export function installChatSelection({ documentRef = document, getScope, getAccount, getChats, canModify = () => true, request, refresh }) {
  const list = documentRef.getElementById('chats');
  const actions = documentRef.querySelector('.chat-sidebar-actions');
  if (!list || !actions) return null;
  const makeButton = (label, path) => {
    const button = documentRef.createElement('button'); button.type = 'button';
    button.title = label; button.setAttribute('aria-label', label);
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return button;
  };
  const tick = 'M5 12l4 4L19 6';
  const toggle = makeButton('Seleccionar chats', 'M9 5h11M9 12h11M9 19h11M3 5h.01M3 12h.01M3 19h.01');
  toggle.id = 'chat-selection-toggle'; toggle.className = 'sidebar-action';
  actions.append(toggle);
  const bar = documentRef.createElement('section'); bar.className = 'chat-selection-bar'; bar.hidden = true; bar.setAttribute('aria-label', 'Selección de conversaciones');
  const count = documentRef.createElement('span'); count.className = 'chat-selection-count'; count.setAttribute('aria-live', 'polite');
  const close = makeButton('Cancelar selección', 'M6 6l12 12M18 6L6 18');
  const all = makeButton('Seleccionar todos los visibles', tick);
  const archive = makeButton('Archivar', 'M3 4h18v4H3zM5 8v12h14V8M9 12h6');
  const mute = makeButton('Silenciar', 'M5 9H2v6h3l5 4V5L5 9M15 9l6 6M21 9l-6 6');
  const read = makeButton('Marcar como leído', 'M3 6h18v13H3zM3 7l9 7 9-7');
  const status = documentRef.createElement('p'); status.className = 'chat-selection-status'; status.setAttribute('role', 'status');
  bar.append(close, count, all, archive, mute, read, status); list.before(bar);
  let active = false; let busy = false; let generation = 0; let scope = ''; const selected = new Set();
  const currentScope = () => String(getScope());
  const rows = () => [...list.querySelectorAll('[data-chat-id]')];
  function stop(restoreFocus = false) {
    active = false; busy = false; generation++; selected.clear(); bar.hidden = true;
    toggle.setAttribute('aria-pressed', 'false'); status.textContent = ''; sync();
    if (restoreFocus) toggle.focus();
  }
  function sync() {
    if (active && scope !== currentScope()) { stop(); return; }
    const visible = new Set(rows().map(row => row.dataset.chatId));
    for (const id of selected) if (!visible.has(id)) selected.delete(id);
    for (const row of rows()) {
      row.classList.toggle('chat-selectable', active);
      row.classList.toggle('chat-is-selected', active && selected.has(row.dataset.chatId));
      if (active) row.setAttribute('aria-pressed', String(selected.has(row.dataset.chatId)));
      else row.removeAttribute('aria-pressed');
    }
    count.textContent = `${selected.size} seleccionados`;
    const chosen = getChats().filter(chat => selected.has(chat.id));
    archive.dataset.action = chosen.length && chosen.every(chat => chat.archived) ? 'unarchive' : 'archive';
    mute.dataset.action = chosen.length && chosen.every(chat => chat.muted) ? 'unmute' : 'mute';
    read.dataset.action = chosen.length && chosen.every(chat => !Number(chat.unread)) ? 'unread' : 'read';
    for (const [button, labels] of [[archive,['Archivar','Desarchivar']], [mute,['Silenciar','Activar sonido']], [read,['Marcar como leído','Marcar como no leído']]]) {
      const label = labels[button.dataset.action.startsWith('un') ? 1 : 0];
      button.title = label; button.setAttribute('aria-label', label); button.disabled = busy || !selected.size || !canModify();
    }
    all.disabled = busy || !visible.size;
  }
  toggle.onclick = () => {
    if (active) { stop(true); return; }
    active = true; scope = currentScope(); generation++; bar.hidden = false; toggle.setAttribute('aria-pressed', 'true'); sync(); close.focus();
  };
  close.onclick = () => stop(true);
  all.onclick = () => { for (const row of rows()) selected.add(row.dataset.chatId); sync(); };
  list.addEventListener('click', event => {
    if (!active) return;
    const row = event.target.closest('[data-chat-id]'); if (!row) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (busy) return;
    const id = row.dataset.chatId; if (selected.has(id)) selected.delete(id); else selected.add(id); sync();
  }, true);
  async function apply(action) {
    if (busy || !selected.size || !canModify() || scope !== currentScope()) return;
    const token = generation; const account = getAccount();
    const ids = [...selected]; busy = true; status.textContent = `Aplicando a ${ids.length} conversaciones...`; sync();
    const isCurrent = () => active && token === generation && scope === currentScope();
    const results = await applyChatBatch({ account, ids, action, request, isCurrent, onResult: (result, completed) => {
      if (result.ok) selected.delete(result.chat);
      status.textContent = `${completed} de ${ids.length} procesados`; sync();
    }});
    if (!isCurrent()) return;
    const failed = results.filter(result => !result.ok).length;
    busy = false; status.textContent = failed ? `${failed} conversaciones pendientes. Puedes volver a intentarlo.` : 'Cambios aplicados.'; sync();
    await refresh();
  }
  for (const button of [archive,mute,read]) button.onclick = () => { void apply(button.dataset.action); };
  documentRef.addEventListener('keydown', event => {
    if (active && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); stop(true); }
  });
  const observer = new MutationObserver(sync); observer.observe(list, {childList:true});
  return {close:stop, sync};
}
