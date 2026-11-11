// SSE carries change hints only; the existing account-scoped API remains the
// source of message and chat projections.
export function createLiveUpdates({refresh, onHint = () => {}, eventSource = url => new EventSource(url), documentRef = document,
  setIntervalRef = setInterval, clearIntervalRef = clearInterval, setTimeoutRef = setTimeout,
  clearTimeoutRef = clearTimeout, pollMs = 10000, debounceMs = 250,
  reconnectBaseMs = 1000, reconnectMaxMs = 30000, maxHintedChats = 8} = {}) {
  let account = '';
  let generation = 0;
  let stream = null;
  let open = false;
  let pollTimer = null;
  let debounceTimer = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let refreshingGeneration = -1;
  let dirty = false;
  // Conversations announced since the last refresh. null means "full reload":
  // a resync, a storm, or more rows than N single reads are worth.
  let hinted = null;

  function noteHint(type, payload) {
    if (type === 'resync' || typeof payload.conversation_id !== 'string' || !payload.conversation_id) { hinted = null; return; }
    if (!hinted) hinted = new Set();
    hinted.add(payload.conversation_id);
    if (hinted.size > maxHintedChats) hinted = null;
  }

  async function runRefresh() {
    if (!account) return;
    if (refreshingGeneration === generation) { dirty = true; return; }
    const currentGeneration = generation;
    const conversations = hinted === null ? null : Array.from(hinted);
    hinted = null;
    refreshingGeneration = currentGeneration;
    try { await refresh({account, hidden: documentRef.hidden, conversations}); }
    catch { if (currentGeneration === generation && account) startPolling(); }
    finally {
      if (refreshingGeneration === currentGeneration) refreshingGeneration = -1;
      if (dirty && currentGeneration === generation) {
        dirty = false;
        scheduleRefresh();
      }
    }
  }

  function scheduleRefresh() {
    if (debounceTimer || !account) return;
    debounceTimer = setTimeoutRef(() => { debounceTimer = null; void runRefresh(); }, debounceMs);
  }

  function startPolling() {
    if (!pollTimer) pollTimer = setIntervalRef(() => { void runRefresh(); }, pollMs);
  }

  function stopPolling() {
    if (pollTimer) clearIntervalRef(pollTimer);
    pollTimer = null;
  }

  // A server or network outage is exactly when every open tab retries at once, so
  // the gap grows per attempt instead of staying at pollMs; onopen resets it.
  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * (2 ** reconnectAttempts));
    reconnectAttempts += 1;
    reconnectTimer = setTimeoutRef(() => { reconnectTimer = null; connect(); }, delay);
  }

  function connect() {
    if (!account || stream) return;
    const currentGeneration = generation;
    let source;
    try { source = eventSource(`/api/events?${new URLSearchParams({account})}`); }
    catch {
      startPolling();
      scheduleReconnect();
      return;
    }
    stream = source;
    source.onopen = () => {
      if (currentGeneration !== generation) return;
      open = true;
      reconnectAttempts = 0;
      stopPolling();
      scheduleRefresh(); // NOTIFY is not durable, so reconnects always resync.
    };
    source.onerror = () => {
      if (currentGeneration !== generation) return;
      open = false;
      startPolling();
      if (source.readyState === 2) {
        source.close();
        stream = null;
        scheduleReconnect();
      }
    };
    for (const type of ['message', 'chat', 'resync']) source.addEventListener(type, event => {
      if (currentGeneration !== generation) return;
      let payload;
      try {
        payload = JSON.parse(event.data);
        if (payload.account && payload.account !== account) return;
      } catch { return; }
      try { onHint(payload); } catch { /* A notification cannot stop chat updates. */ }
      noteHint(type, payload);
      scheduleRefresh();
    });
  }

  function stop() {
    generation += 1;
    account = '';
    open = false;
    hinted = null;
    reconnectAttempts = 0;
    stream?.close();
    stream = null;
    stopPolling();
    if (debounceTimer) clearTimeoutRef(debounceTimer);
    if (reconnectTimer) clearTimeoutRef(reconnectTimer);
    debounceTimer = null;
    reconnectTimer = null;
    dirty = false;
  }

  function start(nextAccount) {
    stop();
    account = nextAccount || '';
    if (!account) return;
    startPolling();
    connect();
  }

  const onVisibility = () => { if (!documentRef.hidden) scheduleRefresh(); };
  documentRef.addEventListener('visibilitychange', onVisibility);
  return {
    start, stop,
    // True only while a stream is actually open: a send may then skip its own
    // reload, because the hint for its echo arrives on this stream.
    live: () => open && Boolean(account),
    destroy() { stop(); documentRef.removeEventListener('visibilitychange', onVisibility); },
  };
}
