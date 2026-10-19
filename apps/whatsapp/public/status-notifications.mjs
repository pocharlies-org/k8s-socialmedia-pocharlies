import { normalizeNovedadesAuthor, readableAuthor } from './novedades-ui.mjs';

const DEFAULT_POLL_MS = 30000;

function newerStatus(current, previous) {
  if (current.latest !== previous.latest) return current.latest > previous.latest;
  if (current.latestReceivedAt && previous.latestReceivedAt) {
    if (current.latestReceivedAt !== previous.latestReceivedAt) {
      return current.latestReceivedAt > previous.latestReceivedAt;
    }
    return Boolean(current.latestStatusId && previous.latestStatusId &&
      current.latestStatusId > previous.latestStatusId);
  }
  return Boolean(current.latestStatusId && previous.latestStatusId &&
    current.latestStatusId !== previous.latestStatusId);
}

export function createStatusNotificationMonitor({
  loadAuthors,
  onStatus,
  documentRef = document,
  windowRef = globalThis.window,
  getAccount,
  permission,
  setIntervalRef = setInterval,
  clearIntervalRef = clearInterval,
  setTimeoutRef = setTimeout,
  clearTimeoutRef = clearTimeout,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  let account = '';
  let generation = 0;
  let pendingGeneration = -1;
  let baseline = null;
  let timer = null;
  let visibilityTimer = null;

  function cancelVisibilityCheck() {
    if (visibilityTimer) clearTimeoutRef(visibilityTimer);
    visibilityTimer = null;
  }

  async function check() {
    const currentGeneration = generation;
    const currentAccount = account;
    if (!currentAccount || pendingGeneration === currentGeneration || getAccount() !== currentAccount) return;
    pendingGeneration = currentGeneration;
    try {
      const response = await loadAuthors(currentAccount);
      if (generation !== currentGeneration || getAccount() !== currentAccount ||
        response?.account !== currentAccount || !Array.isArray(response.authors)) return;
      const next = new Map();
      for (const raw of response.authors) {
        const author = normalizeNovedadesAuthor(raw);
        if (!author || !author.latestTimestamp) continue;
        const previous = next.get(author.id);
        const latest = author.latestTimestamp.getTime();
        const status = { latest, latestStatusId: author.latestStatusId,
          latestReceivedAt: author.latestReceivedAt, unseen: author.unseen,
          own: author.own, name: readableAuthor(author.id, author.name) };
        if (!previous || newerStatus(status, previous)) {
          next.set(author.id, status);
        }
      }
      if (baseline && documentRef.hidden && permission() === 'granted') {
        for (const [id, status] of next) {
          if (status.own || status.unseen <= 0) continue;
          const previous = baseline.get(id);
          if (previous && !newerStatus(status, previous)) continue;
          try { onStatus({ account: currentAccount, author: id, name: status.name, latest: status.latest }); }
          catch { /* Notification delivery must not interrupt the baseline. */ }
        }
      }
      baseline = next;
    } catch { /* A failed read preserves the last confirmed baseline. */ }
    finally { if (pendingGeneration === currentGeneration) pendingGeneration = -1; }
  }

  function stop() {
    generation += 1;
    account = '';
    baseline = null;
    cancelVisibilityCheck();
    if (timer) clearIntervalRef(timer);
    timer = null;
  }

  function start(nextAccount) {
    stop();
    account = String(nextAccount || '');
    if (!account) return;
    void check();
    timer = setIntervalRef(() => { void check(); }, pollMs);
    timer?.unref?.();
  }

  const visibilityChanged = () => {
    if (!account) return;
    cancelVisibilityCheck();
    if (!documentRef.hidden) { void check(); return; }
    // Safari fires visibilitychange before pagehide on navigation. Waiting a
    // moment lets pagehide cancel a request that the browser would abort anyway.
    visibilityTimer = setTimeoutRef(() => { visibilityTimer = null; void check(); }, 500);
    visibilityTimer?.unref?.();
  };
  documentRef.addEventListener('visibilitychange', visibilityChanged);
  windowRef?.addEventListener?.('pagehide', cancelVisibilityCheck);
  return { start, check, stop, destroy() {
    stop();
    documentRef.removeEventListener('visibilitychange', visibilityChanged);
    windowRef?.removeEventListener?.('pagehide', cancelVisibilityCheck);
  } };
}
