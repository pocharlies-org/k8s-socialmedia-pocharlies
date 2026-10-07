export function createMessageSearch({request, onChange, delay = 220}) {
  let generation = 0;
  let timer = null;
  let controller = null;
  let state = {account: '', query: '', results: [], nextCursor: null, status: 'idle', error: ''};
  const publish = () => onChange({...state, results: [...state.results]});

  async function loadPage() {
    if (!state.account || !state.query || state.status === 'loading') return;
    const version = generation;
    const {account, query, nextCursor} = state;
    controller = new AbortController();
    state = {...state, status: 'loading', error: ''};
    publish();
    try {
      const page = await request({account, query, cursor: nextCursor, signal: controller.signal});
      if (version !== generation) return;
      if (!page || !Array.isArray(page.results) || (page.account && page.account !== account) || (page.query && page.query !== query)) {
        throw new Error('Respuesta de b\u00fasqueda no v\u00e1lida.');
      }
      if (page.nextCursor && page.nextCursor === nextCursor) throw new Error('No se pudo continuar la b\u00fasqueda.');
      const seen = new Set(state.results.map(item => `${item.chatId || item.chat}:${item.messageId || item.id}`));
      const fresh = page.results.filter(item => {
        const key = `${item.chatId || item.chat}:${item.messageId || item.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      state = {...state, results: [...state.results, ...fresh], nextCursor: page.nextCursor || null, status: state.results.length || fresh.length ? 'ready' : 'empty'};
    } catch (error) {
      if (version !== generation) return;
      state = {...state, status: 'error', error: error.message || 'La b\u00fasqueda no est\u00e1 disponible.'};
    } finally {
      if (version === generation) { controller = null; publish(); }
    }
  }

  function setQuery(query, account) {
    query = String(query || '').trim();
    account = String(account || '');
    if (query === state.query && account === state.account) return;
    generation++;
    clearTimeout(timer);
    controller?.abort();
    controller = null;
    state = {account, query, results: [], nextCursor: null, status: query && account ? 'pending' : 'idle', error: ''};
    publish();
    if (query && account) timer = setTimeout(() => { void loadPage(); }, delay);
  }

  return {
    setQuery,
    loadMore: () => state.nextCursor && state.status !== 'loading' ? loadPage() : Promise.resolve(),
    retry: () => state.status === 'error' ? loadPage() : Promise.resolve(),
    snapshot: () => ({...state, results: [...state.results]}),
  };
}

export function installSidebarMessageSearch({documentRef, input, chatList, getAccount, getChats, request, openMessage, showError, delay = 220}) {
  let archived = false;
  const make = (tag, className, label = '') => {
    const element = documentRef.createElement(tag);
    element.className = className;
    element.textContent = label;
    return element;
  };
  const heading = make('h2', 'sidebar-search-heading', 'Conversaciones');
  heading.hidden = true;
  chatList.before(heading);
  const section = make('section', 'sidebar-message-search');
  section.hidden = true;
  section.setAttribute('aria-label', 'Mensajes encontrados');
  const title = make('h2', 'sidebar-search-heading', 'Mensajes');
  const status = make('p', 'sidebar-search-status');
  status.setAttribute('role', 'status');
  const results = make('div', 'sidebar-search-results');
  section.append(title, status, results);
  chatList.after(section);
  input.setAttribute('aria-label', 'Buscar chats y mensajes');
  input.setAttribute('aria-controls', 'chats sidebar-message-search');
  input.placeholder = 'Buscar chats y mensajes';
  section.id = 'sidebar-message-search';

  const search = createMessageSearch({request, onChange: render, delay});
  function render(snapshot) {
    const activeKey = documentRef.activeElement?.dataset?.searchKey;
    const visible = Boolean(snapshot.query && snapshot.account);
    heading.hidden = !visible;
    section.hidden = !visible;
    results.replaceChildren();
    if (!visible) { status.textContent = ''; return; }
    status.textContent = snapshot.status === 'pending' || snapshot.status === 'loading'
      ? 'Buscando mensajes...'
      : snapshot.status === 'empty' ? 'No se encontraron mensajes.'
      : snapshot.status === 'error' ? snapshot.error : '';
    for (const item of snapshot.results) {
      const chatId = String(item.chatId || item.chat || '');
      const messageId = String(item.messageId || item.id || '');
      if (!chatId || !messageId) continue;
      const row = make('button', 'sidebar-message-result');
      row.type = 'button';
      row.dataset.searchKey = `${chatId}:${messageId}`;
      row.append(make('strong', '', item.chatName || chatId), make('span', '', item.text || 'Mensaje sin texto'), make('small', '', item.timestamp ? new Date(item.timestamp).toLocaleString('es-ES') : ''));
      row.onclick = async () => {
        if (getAccount() !== snapshot.account) return;
        row.disabled = true;
        try {
          const chat = getChats().find(candidate => String(candidate.id) === chatId) || {id: chatId, name: item.chatName || chatId, isGroup: chatId.endsWith('@g.us')};
          await openMessage(chat, messageId, snapshot.account);
        } catch (error) {
          if (getAccount() === snapshot.account) showError(error.message || 'No se pudo abrir el mensaje.');
        } finally { row.disabled = false; }
      };
      results.append(row);
    }
    if (snapshot.nextCursor && snapshot.status !== 'error') {
      const more = make('button', 'sidebar-search-more', snapshot.status === 'loading' ? 'Cargando...' : 'M\u00e1s resultados');
      more.type = 'button';
      more.setAttribute('aria-disabled', String(snapshot.status === 'loading'));
      more.dataset.searchKey = 'more';
      more.onclick = () => { if (snapshot.status !== 'loading') void search.loadMore(); };
      results.append(more);
    }
    if (snapshot.status === 'error' || (snapshot.status === 'loading' && activeKey === 'retry')) {
      const retry = make('button', 'sidebar-search-more', snapshot.status === 'loading' ? 'Reintentando...' : 'Reintentar');
      retry.type = 'button';
      retry.dataset.searchKey = 'retry';
      retry.setAttribute('aria-disabled', String(snapshot.status === 'loading'));
      retry.onclick = () => { if (snapshot.status === 'error') void search.retry(); };
      results.append(retry);
    }
    if (activeKey) {
      const rows = [...results.querySelectorAll('[data-search-key]')];
      const target = rows.find(row => row.dataset.searchKey === activeKey)
        || (activeKey === 'more' ? rows.find(row => row.dataset.searchKey === 'retry') || rows.at(-1) : null)
        || (activeKey === 'retry' ? rows.find(row => row.className === 'sidebar-message-result') || status : null);
      if (target === status) status.tabIndex = -1;
      target?.focus({preventScroll: true});
    }
  }

  function changed() { search.setQuery(archived ? '' : input.value, getAccount()); }
  function viewChanged(isArchived) {
    if (archived === Boolean(isArchived)) return;
    archived = Boolean(isArchived);
    if (archived) input.value = '';
    changed();
  }
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && input.value) { input.value = ''; changed(); input.dispatchEvent(new Event('input')); event.preventDefault(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'Enter') return;
    const first = chatList.querySelector('.chat-item') || results.querySelector('.sidebar-message-result');
    if (first) { event.preventDefault(); if (event.key === 'Enter') first.click(); else first.focus(); }
  });
  documentRef.querySelector('.chat-sidebar').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key) || event.target === input) return;
    if (event.key === 'Escape') { input.focus(); event.preventDefault(); return; }
    const rows = [...chatList.querySelectorAll('.chat-item'), ...results.querySelectorAll('.sidebar-message-result, .sidebar-search-more')].filter(row => !row.disabled);
    const index = rows.indexOf(event.target);
    if (index < 0) return;
    const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) { next.focus(); event.preventDefault(); }
    else if (event.key === 'ArrowUp') { input.focus(); event.preventDefault(); }
  });
  changed();
  return {changed, viewChanged, accountChanged: changed, snapshot: search.snapshot};
}
