export const SETTINGS_KEYS = Object.freeze({
  spellcheck: 'wa-spellcheck',
  emojiReplacement: 'wa-emoji-replacement',
  enterToSend: 'wa-enter-to-send',
  wallpaper: 'wa-chat-wallpaper',
  mediaAutoDownload: 'wa-media-autodownload',
});

export const MEDIA_DOWNLOAD_TYPES = Object.freeze(['image', 'audio', 'video', 'document']);
// WhatsApp Web reference: Chats > Descarga automatica keeps Photos and Audio on
// and Videos and Documents off. https://faq.whatsapp.com/366146522333492
export const DEFAULT_MEDIA_DOWNLOAD = Object.freeze({ image: true, audio: true, video: false, document: false });
export const MEDIA_AUTO_MAX_BYTES = 32 * 1024 * 1024;
export const MEDIA_EXPLICIT_MAX_BYTES = 256 * 1024 * 1024;
const MEDIA_DEFAULT_BUCKET = '*';
const MEDIA_CACHE_MAX_ENTRIES = 40;
const MEDIA_CACHE_MAX_BYTES = 96 * 1024 * 1024;

const WALLPAPERS = new Set(['default', 'sand', 'sage', 'slate']);
const EMOJI_SHORTCUTS = [
  [":'(", '😢'], [':-)', '🙂'], [':)', '🙂'], [':-D', '😄'], [':D', '😄'],
  [';-)', '😉'], [';)', '😉'], [':-(', '🙁'], [':(', '🙁'],
  [':-P', '😛'], [':P', '😛'], [':-O', '😮'], [':O', '😮'], ['<3', '❤️'],
];

export function emojiShortcutAtCaret(value, caret) {
  if (typeof value !== 'string' || !Number.isInteger(caret) || caret < 0 || caret > value.length) return null;
  const before = value.slice(0, caret);
  if (/^[\p{L}\p{N}_]/u.test(value.slice(caret))) return null;
  for (const [shortcut, emoji] of EMOJI_SHORTCUTS) {
    if (!before.toLowerCase().endsWith(shortcut.toLowerCase())) continue;
    const start = caret - shortcut.length;
    if (start > 0 && !/[\s([{]/u.test(value[start - 1])) continue;
    return { start, end: caret, emoji };
  }
  return null;
}

export function readSettings(storage) {
  const read = key => { try { return storage?.getItem(key); } catch { return null; } };
  const wallpaper = read(SETTINGS_KEYS.wallpaper);
  return {
    spellcheck: read(SETTINGS_KEYS.spellcheck) !== 'false',
    emojiReplacement: read(SETTINGS_KEYS.emojiReplacement) !== 'false',
    enterToSend: read(SETTINGS_KEYS.enterToSend) !== 'false',
    wallpaper: WALLPAPERS.has(wallpaper) ? wallpaper : 'default',
  };
}

function resolveMediaStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function mediaBucketFor(accountId) {
  return typeof accountId === 'string' && accountId.trim() ? accountId : MEDIA_DEFAULT_BUCKET;
}

function readMediaMap(storage) {
  let raw = null;
  try { raw = resolveMediaStorage(storage)?.getItem?.(SETTINGS_KEYS.mediaAutoDownload) ?? null; } catch { raw = null; }
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** Effective auto-download flags for one account: defaults < shared bucket < account bucket. */
export function readMediaSettings(storage, accountId = '') {
  const map = readMediaMap(storage);
  const buckets = [map[mediaBucketFor(accountId)], map[MEDIA_DEFAULT_BUCKET]];
  const settings = {};
  for (const type of MEDIA_DOWNLOAD_TYPES) {
    let value;
    for (const bucket of buckets) {
      if (bucket && typeof bucket === 'object' && typeof bucket[type] === 'boolean') { value = bucket[type]; break; }
    }
    settings[type] = value ?? DEFAULT_MEDIA_DOWNLOAD[type];
  }
  return settings;
}

export function writeMediaSettings(storage, accountId, partial) {
  const map = readMediaMap(storage);
  const next = { ...readMediaSettings(storage, accountId) };
  for (const type of MEDIA_DOWNLOAD_TYPES) {
    if (partial?.[type] === true || partial?.[type] === false) next[type] = partial[type];
  }
  map[mediaBucketFor(accountId)] = next;
  try { resolveMediaStorage(storage)?.setItem?.(SETTINGS_KEYS.mediaAutoDownload, JSON.stringify(map)); } catch {}
  return next;
}

/**
 * Media bytes stay in memory only, never on disk: a bounded fetch per
 * attachment plus a hard-budget object-URL cache keyed by full media URL, so
 * the account and chat query parameters keep account scopes apart. In-flight
 * chunks count against the same budget. Disk writes happen solely through
 * user clicks on download anchors.
 */
export function createMediaDownloadPolicy(options = {}) {
  const {
    storage,
    fetchImpl,
    autoMaxBytes = MEDIA_AUTO_MAX_BYTES,
    explicitMaxBytes = MEDIA_EXPLICIT_MAX_BYTES,
    cacheMaxEntries = MEDIA_CACHE_MAX_ENTRIES,
    cacheMaxBytes = MEDIA_CACHE_MAX_BYTES,
  } = options;
  // url -> { objectUrl, size, mime, owners:Set<HTMLElement> }
  const cache = new Map();
  const inFlight = new Map();
  const mountObservers = new Map();
  let inFlightBytes = 0;
  const forget = entry => { try { globalThis.URL?.revokeObjectURL?.(entry.objectUrl); } catch {} };
  const isLive = owner => owner?.isConnected === true;
  const hasLiveOwner = entry => {
    for (const owner of entry.owners || []) if (isLive(owner)) return true;
    return false;
  };
  const registerOwner = (entry, owner) => { if (owner) entry.owners.add(owner); };
  const cachedBytes = () => {
    let total = 0;
    for (const entry of cache.values()) total += entry.size;
    return total;
  };
  const evict = (needed = 0) => {
    // Live media keeps its URL; refuse the next load if it cannot fit.
    for (const [key, entry] of [...cache]) {
      if (cache.size < cacheMaxEntries && cachedBytes() + inFlightBytes + needed <= cacheMaxBytes) break;
      for (const owner of entry.owners) if (!isLive(owner)) entry.owners.delete(owner);
      if (hasLiveOwner(entry)) continue;
      cache.delete(key);
      forget(entry);
    }
  };
  const tooLarge = () => Object.assign(new Error('El archivo supera el limite de descarga automatica.'), { code: 'MEDIA_TOO_LARGE' });
  const cacheFull = () => Object.assign(new Error('No hay memoria disponible para mostrar mas archivos. Cierra otros adjuntos o descarga el archivo directamente.'), { code: 'MEDIA_CACHE_FULL' });
  const cancelled = () => Object.assign(new Error('Descarga cancelada.'), { code: 'MEDIA_CANCELLED' });
  const stopTask = task => {
    if (task.cancelled) return;
    task.cancelled = true;
    task.abortController.abort();
    try { void task.reader?.cancel?.().catch?.(() => {}); } catch {}
  };
  const cancelDisconnected = () => {
    for (const task of inFlight.values()) {
      for (const waiter of task.waiters) {
        if (waiter.cancelled || !waiter.owner) continue;
        if (isLive(waiter.owner)) waiter.seenConnected = true;
        else if (waiter.seenConnected) waiter.cancelled = true;
      }
      if (task.waiters.every(waiter => waiter.cancelled)) stopTask(task);
    }
  };
  const observeMount = owner => {
    const documentRef = owner?.ownerDocument;
    if (!documentRef?.documentElement || typeof MutationObserver === 'undefined' || mountObservers.has(documentRef)) return;
    const observer = new MutationObserver(cancelDisconnected);
    observer.observe(documentRef.documentElement, { childList: true, subtree: true });
    mountObservers.set(documentRef, observer);
  };
  const releaseObservers = () => {
    if (inFlight.size) return;
    for (const observer of mountObservers.values()) observer.disconnect();
    mountObservers.clear();
  };
  return {
    autoMaxBytes,
    explicitMaxBytes,
    enabled(type, accountId = '') {
      return readMediaSettings(storage, accountId)[type] === true;
    },
    cachedUrl(url, { maxBytes = Number.POSITIVE_INFINITY, owner = null } = {}) {
      const entry = cache.get(url);
      if (!entry || entry.size > maxBytes) return null;
      cache.delete(url);
      cache.set(url, entry);
      registerOwner(entry, owner);
      return entry.objectUrl;
    },
    async loadBytes(url, { maxBytes = autoMaxBytes, owner = null } = {}) {
      const hit = cache.get(url);
      if (hit) {
        if (hit.size > maxBytes) throw tooLarge();
        cache.delete(url);
        cache.set(url, hit);
        registerOwner(hit, owner);
        return { objectUrl: hit.objectUrl, size: hit.size, mime: hit.mime, fromCache: true, cached: true };
      }
      const pending = inFlight.get(url);
      if (pending && !pending.cancelled) {
        const waiter = { owner, maxBytes, cancelled: false, seenConnected: isLive(owner) };
        pending.waiters.push(waiter);
        observeMount(owner);
        const entry = await pending.promise;
        if (waiter.cancelled) throw cancelled();
        if (entry.size > maxBytes) throw tooLarge();
        return { objectUrl: entry.objectUrl, size: entry.size, mime: entry.mime, fromCache: false, cached: true };
      }
      const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
      if (typeof fetchFn !== 'function') throw new Error('Descarga no disponible en este entorno.');
      const waiter = { owner, maxBytes, cancelled: false, seenConnected: isLive(owner) };
      const task = { waiters: [waiter], reserved: 0, promise: null, reader: null, cancelled: false, abortController: new AbortController() };
      const reserve = bytes => {
        evict(bytes);
        if (cache.size >= cacheMaxEntries || cachedBytes() + inFlightBytes + bytes > cacheMaxBytes) throw cacheFull();
        task.reserved += bytes;
        inFlightBytes += bytes;
      };
      task.promise = (async () => {
      const response = await fetchFn(url, { credentials: 'same-origin', signal: task.abortController.signal });
      if (task.cancelled) throw cancelled();
      if (!response?.ok) throw new Error(`No se pudo descargar el archivo (${response?.status ?? 'sin respuesta'}).`);
      const declared = Number(response.headers?.get?.('content-length') || 0);
      const allowed = () => Math.max(...task.waiters.filter(waiter => !waiter.cancelled).map(waiter => waiter.maxBytes));
      if (Number.isFinite(declared) && declared > allowed()) {
        try { await response.body?.cancel?.(); } catch {}
        throw tooLarge();
      }
      if (declared > cacheMaxBytes) {
        try { await response.body?.cancel?.(); } catch {}
        throw cacheFull();
      }
      const mime = String(response.headers?.get?.('content-type') || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
      let blob;
      let size = 0;
      if (typeof response.body?.getReader === 'function') {
        const reader = response.body.getReader();
        task.reader = reader;
        const chunks = [];
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (task.cancelled) throw cancelled();
            if (done) break;
            const bytes = value?.byteLength || 0;
            if (size + bytes > allowed()) throw tooLarge();
            reserve(bytes);
            size += bytes;
            if (value) chunks.push(value);
          }
        } catch (error) {
          try { await reader.cancel(); } catch {}
          throw error;
        } finally {
          task.reader = null;
          try { reader.releaseLock(); } catch {}
        }
        blob = new Blob(chunks, { type: mime });
      } else {
        // Without streaming, an unknown length cannot be bounded before allocation.
        if (!declared) throw Object.assign(new Error('El servidor no ofrece una descarga acotada.'), { code: 'MEDIA_UNBOUNDED' });
        reserve(declared);
        const buffer = await response.arrayBuffer();
        if (task.cancelled) throw cancelled();
        if (buffer.byteLength > allowed()) throw tooLarge();
        if (buffer.byteLength > declared) throw cacheFull();
        blob = new Blob([buffer], { type: mime });
        size = buffer.byteLength;
      }
      if (task.cancelled) throw cancelled();
      evict();
      if (cache.size >= cacheMaxEntries) throw cacheFull();
      const owners = new Set(task.waiters.filter(waiter => !waiter.cancelled && size <= waiter.maxBytes && waiter.owner).map(waiter => waiter.owner));
      const entry = { objectUrl: globalThis.URL.createObjectURL(blob), size, mime, url, owners };
      inFlightBytes -= task.reserved;
      task.reserved = 0;
      cache.set(url, entry);
      return entry;
      })().catch(error => { if (task.cancelled) throw cancelled(); throw error; });
      inFlight.set(url, task);
      observeMount(owner);
      try {
        const entry = await task.promise;
        if (waiter.cancelled) throw cancelled();
        if (entry.size > maxBytes) throw tooLarge();
        return { objectUrl: entry.objectUrl, size: entry.size, mime: entry.mime, fromCache: false, cached: true };
      } finally {
        inFlightBytes -= task.reserved;
        if (inFlight.get(url) === task) inFlight.delete(url);
        releaseObservers();
      }
    },
    /** Withdraw one mount from an in-flight download without affecting other mounts. */
    cancel(url, owner) {
      const task = inFlight.get(url);
      if (!task) return false;
      let changed = false;
      for (const waiter of task.waiters) if (waiter.owner === owner && !waiter.cancelled) {
        waiter.cancelled = true;
        changed = true;
      }
      if (task.waiters.every(waiter => waiter.cancelled)) stopTask(task);
      return changed;
    },
    /** True while the object URL can still serve bytes. */
    isLive(objectUrl) {
      for (const entry of cache.values()) if (entry.objectUrl === objectUrl) return true;
      return false;
    },
    /** Give up one mount's claim; the copy remains in the bounded LRU cache. */
    release(objectUrl, owner = null) {
      for (const entry of cache.values()) if (entry.objectUrl === objectUrl) {
        if (owner) entry.owners.delete(owner);
        evict();
        return true;
      }
      return false;
    },
    cacheStats() {
      return { entries: cache.size, uncachedEntries: 0, bytes: cachedBytes(), inFlightBytes };
    },
    /** Drop memory-resident copies whose mounts all disconnected and free dead cache slots. */
    sweep() {
      cancelDisconnected();
      evict();
      return { entries: cache.size, uncachedEntries: 0, bytes: cachedBytes() };
    },
    clearCache() {
      for (const task of inFlight.values()) stopTask(task);
      for (const entry of cache.values()) forget(entry);
      cache.clear();
    },
  };
}

export function initializeSettings(documentRef = document, storage = globalThis.localStorage, fetchImpl = globalThis.fetch) {
  const details = documentRef.querySelector('.rail-settings');
  const panel = documentRef.getElementById('settings-panel');
  const summary = details?.querySelector('summary');
  const composer = documentRef.getElementById('message');
  if (!details || !panel || !summary || !composer) return;

  const spellcheck = documentRef.getElementById('settings-spellcheck');
  const emojiReplacement = documentRef.getElementById('settings-emoji-replacement');
  const enterToSend = documentRef.getElementById('settings-enter-send');
  const logout = documentRef.getElementById('settings-logout');
  const logoutError = documentRef.getElementById('settings-logout-error');
  const wallpaperOptions = [...documentRef.querySelectorAll('input[name="wallpaper"]')];
  const persist = (key, value) => { try { storage?.setItem(key, value); } catch {} };
  const settings = readSettings(storage);

  spellcheck.checked = settings.spellcheck;
  composer.spellcheck = settings.spellcheck;
  emojiReplacement.checked = settings.emojiReplacement;
  enterToSend.checked = settings.enterToSend;
  documentRef.body.dataset.wallpaper = settings.wallpaper;
  wallpaperOptions.find(option => option.value === settings.wallpaper).checked = true;

  spellcheck.addEventListener('change', () => {
    composer.spellcheck = spellcheck.checked;
    persist(SETTINGS_KEYS.spellcheck, String(spellcheck.checked));
  });
  emojiReplacement.addEventListener('change', () => {
    persist(SETTINGS_KEYS.emojiReplacement, String(emojiReplacement.checked));
  });
  composer.addEventListener('input', event => {
    if (!emojiReplacement.checked || event.isComposing || event.inputType !== 'insertText') return;
    if (composer.selectionStart !== composer.selectionEnd) return;
    const replacement = emojiShortcutAtCaret(composer.value, composer.selectionStart);
    if (!replacement) return;
    composer.setRangeText(replacement.emoji, replacement.start, replacement.end, 'end');
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  });
  enterToSend.addEventListener('change', () => {
    persist(SETTINGS_KEYS.enterToSend, String(enterToSend.checked));
    documentRef.dispatchEvent(new CustomEvent('wa:enter-to-send-change', { detail: { enabled: enterToSend.checked } }));
  });
  for (const option of wallpaperOptions) option.addEventListener('change', () => {
    if (!option.checked || !WALLPAPERS.has(option.value)) return;
    documentRef.body.dataset.wallpaper = option.value;
    persist(SETTINGS_KEYS.wallpaper, option.value);
  });

  const accountSelect = documentRef.getElementById('account');
  const mediaInputs = new Map(MEDIA_DOWNLOAD_TYPES.map(type => [type, documentRef.getElementById(`settings-autodownload-${type}`)]));
  const activeMediaAccount = () => accountSelect?.value || '';
  const syncMediaInputs = () => {
    const effective = readMediaSettings(storage, activeMediaAccount());
    for (const [type, input] of mediaInputs) {
      if (input && input.checked !== effective[type]) input.checked = effective[type];
    }
  };
  syncMediaInputs();
  for (const [type, input] of mediaInputs) input?.addEventListener('change', () => {
    writeMediaSettings(storage, activeMediaAccount(), { [type]: input.checked });
    documentRef.dispatchEvent?.(new CustomEvent('wa:media-autodownload-change', {
      detail: { mediaType: type, enabled: input.checked, account: activeMediaAccount() },
    }));
  });
  documentRef.addEventListener?.('change', event => {
    if (event?.target === accountSelect) syncMediaInputs();
  });
  accountSelect?.addEventListener?.('change', () => syncMediaInputs());
  if (accountSelect && typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => syncMediaInputs()).observe(accountSelect, { childList: true, subtree: true, characterData: true });
  }
  let mediaSyncTimer = null;
  const setMediaSyncTimer = active => {
    if (active && mediaSyncTimer === null) mediaSyncTimer = globalThis.setInterval?.(syncMediaInputs, 1000) ?? null;
    if (!active && mediaSyncTimer !== null) { globalThis.clearInterval?.(mediaSyncTimer); mediaSyncTimer = null; }
  };

  const close = (restoreFocus = false) => {
    details.open = false;
    if (restoreFocus) summary.focus();
  };
  documentRef.getElementById('settings-close')?.addEventListener('click', () => close(true));
  details.addEventListener('toggle', () => {
    summary.setAttribute('aria-expanded', String(details.open));
    if (details.open) {
      syncMediaInputs();
      setMediaSyncTimer(true);
      documentRef.getElementById('settings-close')?.focus();
    } else setMediaSyncTimer(false);
  });
  documentRef.addEventListener('pointerdown', event => {
    if (details.open && !details.contains(event.target)) close();
  });
  documentRef.addEventListener('keydown', event => {
    if (!details.open || event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    close(true);
  });

  logout.addEventListener('click', async () => {
    if (logout.disabled) return;
    logout.disabled = true;
    logoutError.hidden = true;
    try {
      const response = await fetchImpl('/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error(`No se pudo cerrar la sesión (${response.status}).`);
      try { globalThis.sessionStorage?.removeItem('wa-unconfirmed-outbox-v1'); } catch {}
      globalThis.location.assign('/auth/login');
    } catch (error) {
      logoutError.textContent = error.message || 'No se pudo cerrar la sesión.';
      logoutError.hidden = false;
      logout.disabled = false;
    }
  });
}

if (typeof document !== 'undefined') initializeSettings();
