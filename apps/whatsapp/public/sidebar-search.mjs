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
  let selected = 'conversations';
  let manualSelection = false;
  let searchKey = '';
  const selector = make('div', 'sidebar-search-selector');
  selector.hidden = true;
  selector.setAttribute('role', 'tablist');
  selector.setAttribute('aria-label', 'Resultados de b\u00fasqueda');
  const conversationsButton = make('button', 'sidebar-search-view');
  const messagesButton = make('button', 'sidebar-search-view');
  conversationsButton.type = messagesButton.type = 'button';
  conversationsButton.id = 'sidebar-conversations-tab';
  messagesButton.id = 'sidebar-messages-tab';
  conversationsButton.setAttribute('role', 'tab');
  messagesButton.setAttribute('role', 'tab');
  conversationsButton.setAttribute('aria-controls', chatList.id);
  messagesButton.setAttribute('aria-controls', 'sidebar-message-search');
  selector.append(conversationsButton, messagesButton);
  chatList.before(selector);
  const emptyChats = make('p', 'sidebar-search-status', 'No se encontraron conversaciones.');
  emptyChats.hidden = true;
  chatList.before(emptyChats);
  const section = make('section', 'sidebar-message-search');
  section.hidden = true;
  section.setAttribute('aria-label', 'Mensajes encontrados');
  const status = make('p', 'sidebar-search-status');
  status.setAttribute('role', 'status');
  const results = make('div', 'sidebar-search-results');
  section.append(status, results);
  chatList.after(section);
  input.setAttribute('aria-label', 'Buscar chats y mensajes');
  input.setAttribute('aria-controls', 'chats sidebar-message-search');
  input.placeholder = 'Buscar chats y mensajes';
  section.id = 'sidebar-message-search';

  const search = createMessageSearch({request, onChange: render, delay});
  function updateView(snapshot = search.snapshot()) {
    const visible = Boolean(snapshot.query && snapshot.account);
    const currentChats = new Set(getChats().map(chat => String(chat.id)));
    const chatCount = [...chatList.querySelectorAll('.chat-item')].filter(row => currentChats.has(row.dataset.chatId)).length;
    if (!manualSelection) selected = chatCount ? 'conversations' : 'messages';
    selector.hidden = !visible;
    chatList.hidden = visible && selected !== 'conversations';
    section.hidden = !visible || selected !== 'messages';
    emptyChats.hidden = !visible || selected !== 'conversations' || chatCount > 0;
    conversationsButton.textContent = `Conversaciones (${chatCount})`;
    messagesButton.textContent = `Mensajes (${snapshot.results.length}${snapshot.nextCursor ? '+' : ''})`;
    conversationsButton.setAttribute('aria-selected', String(selected === 'conversations'));
    messagesButton.setAttribute('aria-selected', String(selected === 'messages'));
    conversationsButton.tabIndex = selected === 'conversations' ? 0 : -1;
    messagesButton.tabIndex = selected === 'messages' ? 0 : -1;
    if (visible) {
      chatList.setAttribute('role', 'tabpanel');
      chatList.setAttribute('aria-labelledby', conversationsButton.id);
    } else {
      chatList.removeAttribute('role');
      chatList.removeAttribute('aria-labelledby');
    }
  }
  function selectView(view) {
    selected = view;
    manualSelection = true;
    updateView();
  }
  conversationsButton.onclick = () => selectView('conversations');
  messagesButton.onclick = () => selectView('messages');
  section.setAttribute('role', 'tabpanel');
  section.setAttribute('aria-labelledby', messagesButton.id);
  selector.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const view = event.key === 'Home' ? 'conversations' : event.key === 'End' ? 'messages'
      : event.target === conversationsButton ? 'messages' : 'conversations';
    selectView(view);
    (view === 'conversations' ? conversationsButton : messagesButton).focus();
    event.preventDefault();
  });
  // Chat rows are refreshed independently by app.js, including after account loading.
  const Observer = documentRef.defaultView?.MutationObserver || globalThis.MutationObserver;
  if (Observer) new Observer(() => updateView()).observe(chatList, {childList: true});
  function render(snapshot) {
    const activeKey = documentRef.activeElement?.dataset?.searchKey;
    const visible = Boolean(snapshot.query && snapshot.account);
    updateView(snapshot);
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
    if (activeKey && !section.hidden) {
      const rows = [...results.querySelectorAll('[data-search-key]')];
      const target = rows.find(row => row.dataset.searchKey === activeKey)
        || (activeKey === 'more' ? rows.find(row => row.dataset.searchKey === 'retry') || rows.at(-1) : null)
        || (activeKey === 'retry' ? rows.find(row => row.className === 'sidebar-message-result') || status : null);
      if (target === status) status.tabIndex = -1;
      target?.focus({preventScroll: true});
    }
  }

  function changed() {
    const query = String(archived ? '' : input.value || '').trim();
    const account = String(getAccount() || '');
    const key = JSON.stringify([account, query]);
    if (key !== searchKey) {
      searchKey = key;
      manualSelection = false;
    }
    search.setQuery(query, account);
    updateView();
  }
  function viewChanged(isArchived) {
    if (archived === Boolean(isArchived)) return;
    archived = Boolean(isArchived);
    if (archived) input.value = '';
    changed();
  }
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && input.value) { input.value = ''; changed(); input.dispatchEvent(new Event('input')); event.preventDefault(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'Enter') return;
    const first = !chatList.hidden ? chatList.querySelector('.chat-item')
      : results.querySelector('.sidebar-message-result, .sidebar-search-more');
    if (first) { event.preventDefault(); if (event.key === 'Enter') first.click(); else first.focus(); }
  });
  documentRef.querySelector('.chat-sidebar').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key) || event.target === input) return;
    if (event.key === 'Escape') { input.focus(); event.preventDefault(); return; }
    const rows = (chatList.hidden ? [...results.querySelectorAll('.sidebar-message-result, .sidebar-search-more')]
      : [...chatList.querySelectorAll('.chat-item')]).filter(row => !row.disabled);
    const index = rows.indexOf(event.target);
    if (index < 0) return;
    const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) { next.focus(); event.preventDefault(); }
    else if (event.key === 'ArrowUp') { input.focus(); event.preventDefault(); }
  });
  changed();
  return {changed, viewChanged, accountChanged: changed, snapshot: search.snapshot};
}
