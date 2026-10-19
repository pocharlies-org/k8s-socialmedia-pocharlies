// SSE carries change hints only; the existing account-scoped API remains the
// source of message and chat projections.
export function createLiveUpdates({refresh, onHint = () => {}, eventSource = url => new EventSource(url), documentRef = document,
  setIntervalRef = setInterval, clearIntervalRef = clearInterval, setTimeoutRef = setTimeout,
  clearTimeoutRef = clearTimeout, pollMs = 10000, debounceMs = 250} = {}) {
  let account = '';
  let generation = 0;
  let stream = null;
  let pollTimer = null;
  let debounceTimer = null;
  let reconnectTimer = null;
  let refreshingGeneration = -1;
  let dirty = false;

  async function runRefresh() {
    if (!account) return;
    if (refreshingGeneration === generation) { dirty = true; return; }
    const currentGeneration = generation;
    refreshingGeneration = currentGeneration;
    try { await refresh({account, hidden: documentRef.hidden}); }
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

  function connect() {
    if (!account || stream) return;
    const currentGeneration = generation;
    let source;
    try { source = eventSource(`/api/events?${new URLSearchParams({account})}`); }
    catch {
      startPolling();
      reconnectTimer ||= setTimeoutRef(() => { reconnectTimer = null; connect(); }, pollMs);
      return;
    }
    stream = source;
    source.onopen = () => {
      if (currentGeneration !== generation) return;
      stopPolling();
      scheduleRefresh(); // NOTIFY is not durable, so reconnects always resync.
    };
    source.onerror = () => {
      if (currentGeneration !== generation) return;
      startPolling();
      if (source.readyState === 2) {
        source.close();
        stream = null;
        reconnectTimer ||= setTimeoutRef(() => { reconnectTimer = null; connect(); }, pollMs);
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
      scheduleRefresh();
    });
  }

  function stop() {
    generation += 1;
    account = '';
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
  return {start, stop, destroy() { stop(); documentRef.removeEventListener('visibilitychange', onVisibility); }};
}
