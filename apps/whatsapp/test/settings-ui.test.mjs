import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createMediaDownloadPolicy,
  DEFAULT_MEDIA_DOWNLOAD,
  emojiShortcutAtCaret,
  initializeSettings,
  readMediaSettings,
  readSettings,
  SETTINGS_KEYS,
  writeMediaSettings,
} from '../public/settings-ui.mjs';

class Element extends EventTarget {
  constructor(value = '') { super(); this.value = value; this.checked = false; this.disabled = false; this.hidden = false; this.open = false; this.dataset = {}; this.attrs = {}; }
  setAttribute(name, value) { this.attrs[name] = value; }
  focus() { this.focused = true; }
  contains(target) { return target === this; }
}

function fixture(saved = {}) {
  const values = new Map(Object.entries(saved));
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const ids = new Map(['settings-panel', 'message', 'settings-spellcheck', 'settings-emoji-replacement', 'settings-enter-send', 'settings-logout', 'settings-logout-error', 'settings-close'].map(id => [id, new Element()]));
  const details = new Element();
  const summary = new Element();
  details.querySelector = () => summary;
  const radios = ['default', 'sand', 'sage', 'slate'].map(value => new Element(value));
  const document = new EventTarget();
  document.body = new Element();
  document.getElementById = id => ids.get(id);
  document.querySelector = () => details;
  document.querySelectorAll = () => radios;
  return { document, details, summary, ids, radios, storage, values };
}

test('local preferences restore, update composer, and emit Enter preference', () => {
  const f = fixture({ [SETTINGS_KEYS.spellcheck]: 'false', [SETTINGS_KEYS.emojiReplacement]: 'false', [SETTINGS_KEYS.enterToSend]: 'false', [SETTINGS_KEYS.wallpaper]: 'sage' });
  const originalCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } };
  try {
    initializeSettings(f.document, f.storage, async () => ({ ok: true }));
    assert.equal(f.ids.get('message').spellcheck, false);
    assert.equal(f.ids.get('settings-emoji-replacement').checked, false);
    assert.equal(f.ids.get('settings-enter-send').checked, false);
    assert.equal(f.document.body.dataset.wallpaper, 'sage');
    assert.equal(f.radios[2].checked, true);
    f.ids.get('settings-spellcheck').checked = true;
    f.ids.get('settings-spellcheck').dispatchEvent(new Event('change'));
    assert.equal(f.ids.get('message').spellcheck, true);
    assert.equal(f.values.get(SETTINGS_KEYS.spellcheck), 'true');
    f.ids.get('settings-emoji-replacement').checked = true;
    f.ids.get('settings-emoji-replacement').dispatchEvent(new Event('change'));
    assert.equal(f.values.get(SETTINGS_KEYS.emojiReplacement), 'true');
    let enabled;
    f.document.addEventListener('wa:enter-to-send-change', event => { enabled = event.detail.enabled; });
    f.ids.get('settings-enter-send').checked = true;
    f.ids.get('settings-enter-send').dispatchEvent(new Event('change'));
    assert.equal(enabled, true);
    assert.equal(f.values.get(SETTINGS_KEYS.enterToSend), 'true');
    f.radios[0].checked = true;
    f.radios[0].dispatchEvent(new Event('change'));
    assert.equal(f.document.body.dataset.wallpaper, 'default');
    assert.equal(f.values.get(SETTINGS_KEYS.wallpaper), 'default');
  } finally { globalThis.CustomEvent = originalCustomEvent; }
});

test('emoji shortcuts replace only a complete typed token at the caret', () => {
  assert.deepEqual(emojiShortcutAtCaret('Hola :)', 7), { start: 5, end: 7, emoji: '🙂' });
  assert.deepEqual(emojiShortcutAtCaret('<3', 2), { start: 0, end: 2, emoji: '❤️' });
  assert.equal(emojiShortcutAtCaret('abc:)', 5), null);
  assert.equal(emojiShortcutAtCaret(':)texto', 2), null);
  assert.equal(emojiShortcutAtCaret(':)', 3), null);
});

test('typing a shortcut updates the draft and disabling the setting preserves literal text', () => {
  const f = fixture();
  const composer = f.ids.get('message');
  composer.setRangeText = (text, start, end) => {
    composer.value = composer.value.slice(0, start) + text + composer.value.slice(end);
    composer.selectionStart = composer.selectionEnd = start + text.length;
  };
  let inputEvents = 0;
  composer.addEventListener('input', () => { inputEvents++; });
  initializeSettings(f.document, f.storage, async () => ({ ok: true }));
  assert.equal(f.ids.get('settings-emoji-replacement').checked, true);
  composer.value = 'Hola :)';
  composer.selectionStart = composer.selectionEnd = composer.value.length;
  const typed = new Event('input');
  Object.defineProperties(typed, { inputType: { value: 'insertText' }, data: { value: ')' } });
  composer.dispatchEvent(typed);
  assert.equal(composer.value, 'Hola 🙂');
  assert.equal(inputEvents, 2, 'replacement notifies the draft listener');
  f.ids.get('settings-emoji-replacement').checked = false;
  composer.value = ':)';
  composer.selectionStart = composer.selectionEnd = composer.value.length;
  composer.dispatchEvent(typed);
  assert.equal(composer.value, ':)');
});

test('invalid wallpaper returns to default and settings close on Escape or outside pointer', () => {
  const f = fixture({ [SETTINGS_KEYS.wallpaper]: 'url(javascript:bad)' });
  assert.equal(readSettings(f.storage).wallpaper, 'default');
  initializeSettings(f.document, f.storage, async () => ({ ok: true }));
  f.details.open = true;
  f.document.dispatchEvent(new Event('keydown', { cancelable: true }));
  const escape = new Event('keydown', { cancelable: true });
  Object.defineProperty(escape, 'key', { value: 'Escape' });
  f.document.dispatchEvent(escape);
  assert.equal(f.details.open, false);
  assert.equal(f.summary.focused, true);
  f.details.open = true;
  const outside = new Event('pointerdown');
  Object.defineProperty(outside, 'target', { value: new Element() });
  f.document.dispatchEvent(outside);
  assert.equal(f.details.open, false);
});

test('logout posts to the web auth endpoint and keeps an error visible on failure', async () => {
  const f = fixture();
  let request;
  initializeSettings(f.document, f.storage, async (...args) => { request = args; return { ok: false, status: 403 }; });
  f.ids.get('settings-logout').dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(request, ['/auth/logout', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }]);
  assert.equal(f.ids.get('settings-logout-error').hidden, false);
  assert.equal(f.ids.get('settings-logout').disabled, false);
});

test('settings markup retains account/theme IDs and feature extension hook', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /class="rail-popover"/);
  assert.match(html, /id="account"/);
  assert.match(html, /id="theme"/);
  assert.match(html, /settings-ui\.mjs/);
});

test('settings markup offers the four per-type auto-download switches', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="settings-autodownload-image"/);
  assert.match(html, /id="settings-autodownload-audio"/);
  assert.match(html, /id="settings-autodownload-video"/);
  assert.match(html, /id="settings-autodownload-document"/);
  assert.match(html, /Descarga automática/);
});

function mediaFixture(saved, accountValue = '') {
  const f = fixture(saved);
  const account = new Element();
  account.id = 'account';
  account.value = accountValue;
  f.ids.set('account', account);
  const inputs = {};
  for (const type of ['image', 'audio', 'video', 'document']) {
    const input = new Element();
    input.id = `settings-autodownload-${type}`;
    f.ids.set(input.id, input);
    inputs[type] = input;
  }
  return { ...f, account, inputs };
}

test('auto-download switches follow official WhatsApp defaults for a fresh user', () => {
  const f = mediaFixture({});
  initializeSettings(f.document, f.storage, async () => ({ ok: true }));
  assert.equal(f.inputs.image.checked, true);
  assert.equal(f.inputs.audio.checked, true);
  assert.equal(f.inputs.video.checked, false);
  assert.equal(f.inputs.document.checked, false);
  assert.deepEqual(readMediaSettings(f.storage, 'personal'), DEFAULT_MEDIA_DOWNLOAD);
});

test('auto-download toggles persist per active account and notify the renderer', () => {
  const f = mediaFixture({}, 'personal');
  const events = [];
  f.document.addEventListener('wa:media-autodownload-change', event => events.push(event.detail));
  initializeSettings(f.document, f.storage, async () => ({ ok: true }));
  f.inputs.video.checked = true;
  f.inputs.video.dispatchEvent(new Event('change'));
  assert.deepEqual(events, [{ mediaType: 'video', enabled: true, account: 'personal' }]);
  assert.equal(readMediaSettings(f.storage, 'personal').video, true);
  assert.equal(readMediaSettings(f.storage, 'other').video, false, 'other accounts keep defaults');
  const map = JSON.parse(f.values.get(SETTINGS_KEYS.mediaAutoDownload));
  assert.equal(map.personal.video, true);
  assert.equal(map['*'], undefined, 'account edits never touch the shared bucket');
});

test('media switches re-sync when the active account changes and shared bucket edits apply to all', () => {
  const f = mediaFixture({
    [SETTINGS_KEYS.mediaAutoDownload]: JSON.stringify({ '*': { video: true }, personal: { image: false, audio: true, video: false, document: false } }),
  }, 'personal');
  initializeSettings(f.document, f.storage, async () => ({ ok: true }));
  assert.equal(f.inputs.video.checked, false, 'account bucket beats shared bucket');
  assert.equal(f.inputs.image.checked, false);
  f.account.value = 'secundaria';
  f.account.dispatchEvent(new Event('change'));
  assert.equal(f.inputs.video.checked, true, 'other accounts inherit the shared bucket');
  assert.equal(f.inputs.image.checked, true);
  f.account.value = '';
  f.account.dispatchEvent(new Event('change'));
  f.inputs.audio.checked = false;
  f.inputs.audio.dispatchEvent(new Event('change'));
  assert.equal(readMediaSettings(f.storage, 'personal').audio, true, 'existing account bucket keeps its own audio choice');
  assert.equal(readMediaSettings(f.storage, 'nueva').audio, false, 'accounts without a bucket inherit the shared change');
});

test('media preferences survive corrupt storage and keep boolean validation', () => {
  const corrupt = { getItem: () => '{no-json', setItem: () => {} };
  assert.deepEqual(readMediaSettings(corrupt, 'personal'), DEFAULT_MEDIA_DOWNLOAD);
  const mixed = { getItem: () => JSON.stringify({ '*': { video: 'yes', document: true, image: false } }) };
  const resolved = readMediaSettings(mixed, 'x');
  assert.equal(resolved.video, false, 'non-boolean values fall back to the default');
  assert.equal(resolved.document, true);
  assert.equal(resolved.image, false);
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

function stubFetch(bytes, { contentType = 'application/octet-stream', status = 200, readerChunks = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = readerChunks ? {
      getReader: () => {
        let index = 0;
        return {
          read: async () => (index < readerChunks.length ? { done: false, value: readerChunks[index++] } : { done: true }),
          cancel: async () => { index = readerChunks.length; },
          releaseLock: () => {},
        };
      },
    } : null;
    return {
      ok: status === 200,
      status,
      headers: { get: name => name === 'content-type' ? contentType : name === 'content-length' && !readerChunks ? String(bytes.byteLength) : null },
      body,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  return { fetchImpl, calls };
}

test('a live mount cannot push retained bytes beyond the global cache budget', async () => {
  const bytes = new Uint8Array(4096).fill(7);
  const { fetchImpl, calls } = stubFetch(bytes, { contentType: 'video/mp4' });
  const policy = createMediaDownloadPolicy({
    storage: memoryStorage(), fetchImpl, autoMaxBytes: 1 << 20, explicitMaxBytes: 1 << 20, cacheMaxBytes: 1024,
  });
  const owner = { isConnected: true };
  await assert.rejects(policy.loadBytes('http://nas/api/media/big?account=personal', { maxBytes: 1 << 20, owner }), error => error.code === 'MEDIA_CACHE_FULL');
  assert.equal(calls.length, 1);
  assert.equal(policy.cacheStats().bytes, 0);
});

test('cache hits respect the caller cap and a refused hit never revokes the stored copy', async () => {
  const bytes = new Uint8Array(3000);
  const { fetchImpl, calls } = stubFetch(bytes);
  const policy = createMediaDownloadPolicy({ storage: memoryStorage(), fetchImpl, cacheMaxBytes: 1 << 20, cacheMaxEntries: 10 });
  const mount = { isConnected: true };
  const explicit = await policy.loadBytes('http://nas/api/media/c1?account=x', { maxBytes: 1 << 20, owner: mount });
  assert.equal(explicit.cached, true);
  await assert.rejects(policy.loadBytes('http://nas/api/media/c1?account=x', { maxBytes: 2000, owner: mount }), error => error.code === 'MEDIA_TOO_LARGE');
  assert.equal(calls.length, 1, 'a denied auto hit must not trigger another fetch');
  assert.equal(policy.isLive(explicit.objectUrl), true, 'refusing the hit must not revoke the explicit copy');
  assert.equal(policy.cachedUrl('http://nas/api/media/c1?account=x', { maxBytes: 2000 }), null, 'auto remount above its cap falls back to streaming');
  assert.equal(policy.cachedUrl('http://nas/api/media/c1?account=x'), explicit.objectUrl, 'explicit-scale remount still reuses the copy');
});

test('one cached copy serves two mounts without a second GET', async () => {
  const bytes = new Uint8Array(400);
  const { fetchImpl, calls } = stubFetch(bytes);
  const policy = createMediaDownloadPolicy({ storage: memoryStorage(), fetchImpl, cacheMaxBytes: 1024 });
  const firstMount = { isConnected: true };
  const secondMount = { isConnected: true };
  const url = 'http://nas/api/media/dos-mounts?account=x';
  const first = await policy.loadBytes(url, { maxBytes: 1 << 20, owner: firstMount });
  const second = await policy.loadBytes(url, { maxBytes: 1 << 20, owner: secondMount });
  assert.equal(second.objectUrl, first.objectUrl);
  assert.equal(calls.length, 1, 'the second mount reuses the live copy without refetching');
  assert.equal(second.cached, true);
  firstMount.isConnected = false;
  policy.sweep();
  assert.equal(policy.isLive(first.objectUrl), true, 'the surviving mount keeps its URL alive');
  secondMount.isConnected = false;
  assert.equal(policy.cacheStats().bytes, 400, 'disconnected copies remain within the LRU budget');
});

test('cache budget evicts disconnected entries and keeps account-scoped URLs apart', async () => {
  const bytes = new Uint8Array(64);
  const { fetchImpl, calls } = stubFetch(bytes);
  const policy = createMediaDownloadPolicy({ storage: memoryStorage(), fetchImpl, cacheMaxEntries: 2, cacheMaxBytes: 1 << 20 });
  const first = await policy.loadBytes('http://nas/api/media/a?account=uno', {});
  const second = await policy.loadBytes('http://nas/api/media/a?account=dos', {});
  const third = await policy.loadBytes('http://nas/api/media/b?account=uno', {});
  assert.equal(calls.length, 3);
  assert.equal(policy.cachedUrl('http://nas/api/media/a?account=uno'), null, 'oldest disconnected entry was evicted');
  assert.equal(policy.cachedUrl('http://nas/api/media/a?account=dos'), second.objectUrl, 'same id under another account is a distinct cache entry');
  assert.equal(policy.cachedUrl('http://nas/api/media/b?account=uno'), third.objectUrl);
  assert.equal(policy.cacheStats().entries, 2);
});

test('streamed loads that exceed the cap abort and report a retryable size error', async () => {
  const chunks = [new Uint8Array(700).fill(1), new Uint8Array(700).fill(2)];
  const { fetchImpl } = stubFetch(new Uint8Array(0), { readerChunks: chunks });
  const policy = createMediaDownloadPolicy({ storage: memoryStorage(), fetchImpl });
  await assert.rejects(policy.loadBytes('http://nas/api/media/stream?account=x', { maxBytes: 1000 }), error => error.code === 'MEDIA_TOO_LARGE');
  assert.equal(policy.cacheStats().bytes, 0);
});

test('three live mounts cannot retain more than a 1 KiB global budget', async () => {
  const { fetchImpl } = stubFetch(new Uint8Array(400));
  const policy = createMediaDownloadPolicy({ storage: memoryStorage(), fetchImpl, cacheMaxBytes: 1024 });
  const owners = Array.from({ length: 3 }, () => ({ isConnected: true }));
  const first = await policy.loadBytes('/first?account=uno', { owner: owners[0] });
  const second = await policy.loadBytes('/second?account=uno', { owner: owners[1] });
  await assert.rejects(policy.loadBytes('/third?account=uno', { owner: owners[2] }), error => error.code === 'MEDIA_CACHE_FULL');
  assert.equal(policy.cacheStats().bytes, 800);
  assert.equal(policy.isLive(first.objectUrl), true);
  assert.equal(policy.isLive(second.objectUrl), true);
  owners[0].isConnected = false;
  const third = await policy.loadBytes('/third?account=uno', { owner: owners[2] });
  assert.equal(policy.cacheStats().bytes, 800);
  assert.equal(policy.isLive(first.objectUrl), false);
  assert.equal(policy.isLive(third.objectUrl), true);
});

test('concurrent requests for one URL share the GET and claim both live mounts', async () => {
  let releaseResponse;
  let calls = 0;
  const responseReady = new Promise(resolve => { releaseResponse = resolve; });
  const { fetchImpl } = stubFetch(new Uint8Array(400));
  const policy = createMediaDownloadPolicy({
    storage: memoryStorage(), cacheMaxBytes: 600,
    fetchImpl: async (...args) => { calls += 1; await responseReady; return fetchImpl(...args); },
  });
  const firstOwner = { isConnected: true };
  const secondOwner = { isConnected: true };
  const firstLoad = policy.loadBytes('/same?account=uno', { owner: firstOwner });
  const secondLoad = policy.loadBytes('/same?account=uno', { owner: secondOwner });
  assert.equal(calls, 1);
  releaseResponse();
  const [first, second] = await Promise.all([firstLoad, secondLoad]);
  assert.equal(first.objectUrl, second.objectUrl);
  assert.equal(policy.cacheStats().bytes, 400);
  firstOwner.isConnected = false;
  await assert.rejects(policy.loadBytes('/next?account=uno', { owner: { isConnected: true } }), error => error.code === 'MEDIA_CACHE_FULL');
  assert.equal(policy.isLive(first.objectUrl), true);
  assert.equal(calls, 2);
});

test('coalesced callers keep independent byte limits and only eligible owners', async () => {
  let releaseResponse;
  const responseReady = new Promise(resolve => { releaseResponse = resolve; });
  const { fetchImpl, calls } = stubFetch(new Uint8Array(400));
  const policy = createMediaDownloadPolicy({
    storage: memoryStorage(), cacheMaxBytes: 600,
    fetchImpl: async (...args) => { await responseReady; return fetchImpl(...args); },
  });
  const smallOwner = { isConnected: true };
  const largeOwner = { isConnected: true };
  const small = policy.loadBytes('/mixed?account=uno', { maxBytes: 300, owner: smallOwner });
  const large = policy.loadBytes('/mixed?account=uno', { maxBytes: 500, owner: largeOwner });
  releaseResponse();
  await assert.rejects(small, error => error.code === 'MEDIA_TOO_LARGE');
  const loaded = await large;
  assert.equal(calls.length, 1);
  assert.equal(policy.isLive(loaded.objectUrl), true);
  assert.equal(policy.cacheStats().bytes, 400);
  await assert.rejects(policy.loadBytes('/next?account=uno', { owner: { isConnected: true } }), error => error.code === 'MEDIA_CACHE_FULL');
  assert.equal(policy.isLive(loaded.objectUrl), true);
});

test('unknown-length unstreamable responses fail closed before arrayBuffer allocation', async () => {
  let arrayBufferCalls = 0;
  const policy = createMediaDownloadPolicy({
    storage: memoryStorage(),
    fetchImpl: async () => ({ ok: true, headers: { get: () => null }, body: null,
      arrayBuffer: async () => { arrayBufferCalls += 1; return new ArrayBuffer(1); } }),
  });
  await assert.rejects(policy.loadBytes('/unknown'), error => error.code === 'MEDIA_UNBOUNDED');
  assert.equal(arrayBufferCalls, 0);
});

test('cancelling the last owner aborts an active reader but leaves a shared reader alive', async () => {
  let signal;
  let cancelRead;
  let waitingForRead;
  const readStarted = new Promise(resolve => { waitingForRead = resolve; });
  const fetchImpl = async (_url, init) => {
    signal = init.signal;
    let first = true;
    return { ok: true, headers: { get: () => null }, body: { getReader: () => ({
      read: () => {
        if (first) { first = false; return Promise.resolve({ done: false, value: new Uint8Array(100) }); }
        waitingForRead();
        return new Promise(resolve => { cancelRead = () => resolve({ done: true }); });
      },
      cancel: async () => { cancelRead?.(); }, releaseLock: () => {},
    }) } };
  };
  const policy = createMediaDownloadPolicy({ storage: memoryStorage(), fetchImpl });
  const firstOwner = { isConnected: true };
  const secondOwner = { isConnected: true };
  const first = policy.loadBytes('/slow', { owner: firstOwner });
  const second = policy.loadBytes('/slow', { owner: secondOwner });
  await readStarted;
  assert.equal(policy.cancel('/slow', firstOwner), true);
  assert.equal(signal.aborted, false);
  assert.equal(policy.cancel('/slow', secondOwner), true);
  assert.equal(signal.aborted, true);
  await assert.rejects(first, error => error.code === 'MEDIA_CANCELLED');
  await assert.rejects(second, error => error.code === 'MEDIA_CANCELLED');
  assert.equal(policy.cacheStats().inFlightBytes, 0);
});

test('sweep aborts a reader when its last connected mount disappears', async () => {
  let signal;
  let cancelRead;
  let waitingForRead;
  const readStarted = new Promise(resolve => { waitingForRead = resolve; });
  const policy = createMediaDownloadPolicy({
    storage: memoryStorage(),
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      let first = true;
      return { ok: true, headers: { get: () => null }, body: { getReader: () => ({
        read: () => {
          if (first) { first = false; return Promise.resolve({ done: false, value: new Uint8Array(100) }); }
          waitingForRead();
          return new Promise(resolve => { cancelRead = () => resolve({ done: true }); });
        },
        cancel: async () => { cancelRead?.(); }, releaseLock: () => {},
      }) } };
    },
  });
  const owner = { isConnected: true };
  const loading = policy.loadBytes('/orphan', { owner });
  await readStarted;
  owner.isConnected = false;
  policy.sweep();
  assert.equal(signal.aborted, true);
  await assert.rejects(loading, error => error.code === 'MEDIA_CANCELLED');
  assert.equal(policy.cacheStats().bytes, 0);
});

test('concurrent completions cannot exceed cacheMaxEntries with live owners', async () => {
  let releaseBodies;
  const bodiesReady = new Promise(resolve => { releaseBodies = resolve; });
  let calls = 0;
  const policy = createMediaDownloadPolicy({
    storage: memoryStorage(), cacheMaxEntries: 1, cacheMaxBytes: 1024,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, headers: { get: name => name === 'content-length' ? '400' : null }, body: null,
        arrayBuffer: async () => { await bodiesReady; return new Uint8Array(400).buffer; } };
    },
  });
  const first = policy.loadBytes('/entry-one', { owner: { isConnected: true } });
  const second = policy.loadBytes('/entry-two', { owner: { isConnected: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(policy.cacheStats().inFlightBytes, 800);
  releaseBodies();
  const results = await Promise.allSettled([first, second]);
  assert.equal(calls, 2);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'MEDIA_CACHE_FULL').length, 1);
  assert.equal(policy.cacheStats().entries, 1);
  assert.equal(policy.cacheStats().bytes, 400);
});

test('a new owner can restart a URL while the cancelled reader is still unwinding', async () => {
  let releaseSecond;
  const secondReady = new Promise(resolve => { releaseSecond = resolve; });
  let calls = 0;
  const policy = createMediaDownloadPolicy({
    storage: memoryStorage(),
    fetchImpl: async (_url, init) => {
      calls += 1;
      if (calls === 1) return new Promise((_, reject) => init.signal.addEventListener('abort', () => setImmediate(() => reject(new Error('aborted')))));
      await secondReady;
      return { ok: true, headers: { get: name => name === 'content-length' ? '100' : null }, body: null,
        arrayBuffer: async () => new Uint8Array(100).buffer };
    },
  });
  const oldOwner = { isConnected: true };
  const first = policy.loadBytes('/restart', { owner: oldOwner });
  policy.cancel('/restart', oldOwner);
  const second = policy.loadBytes('/restart', { owner: { isConnected: true } });
  await assert.rejects(first, error => error.code === 'MEDIA_CANCELLED');
  const third = policy.loadBytes('/restart', { owner: { isConnected: true } });
  assert.equal(calls, 2, 'the cancelled task cannot steal the replacement task');
  releaseSecond();
  const [secondResult, thirdResult] = await Promise.all([second, third]);
  assert.equal(secondResult.objectUrl, thirdResult.objectUrl);
  assert.equal(policy.cacheStats().entries, 1);
});
