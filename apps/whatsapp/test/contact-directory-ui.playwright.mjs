/*
 * Synthetic browser QA for the "Nuevo chat" contact drawer.
 *
 * Only the real module is loaded (static import in the fixture page); every
 * directory answer comes from a route in this file, so no connector, account,
 * database or provider call is touched. Any /api request other than the
 * directory one fails the run.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const PERSONAL = Array.from({ length: 61 }, (unused, index) => ({
  key: `346000${String(index).padStart(5, '0')}`,
  label: index === 3 ? 'María Pilar' : `Contacto ${index}`,
  sublabel: `+346000${String(index).padStart(5, '0')}`,
  kind: index < 40 ? 'chat' : 'contact',
  chatId: index < 40 ? `personal:${34600000000 + index}@s.whatsapp.net` : null,
  phone: `+346000${String(index).padStart(5, '0')}`,
  avatarUrl: index === 3 ? '/api/chats/personal:34600000003@s.whatsapp.net/avatar?account=personal'
    : index === 4 ? '/api/chats/personal:34600000004@s.whatsapp.net/avatar?account=secondary' : null,
  source: 'number',
  hasChat: index < 40,
  archived: index === 5,
  canOpen: index < 40,
  canStart: index >= 40,
}));
const SECONDARY = [
  { key: '34611000001', label: 'Bea Sec', kind: 'contact', phone: '+34611000001', canStart: true, hasChat: false },
  { key: 'lid:9988776655', label: 'ID privado', kind: 'private', phone: null, canOpen: false, canStart: false },
];

const state = { requests: [], posts: [], hold: null, overlap: false, fail: false };
const dataset = account => (account === 'secondary' ? SECONDARY : PERSONAL);

function answer(account, params) {
  const items = dataset(account);
  const limit = Number(params.get('limit') || 60);
  const query = (params.get('q') || '').trim();
  const digits = query.replace(/\D/g, '');
  const matches = items.filter(item => !query
    || item.label.toLowerCase().includes(query.toLowerCase())
    || (digits && (item.phone || '').includes(digits)));
  const decode = params.get('cursor')
    ? JSON.parse(Buffer.from(params.get('cursor'), 'base64url').toString('utf8')) : null;
  let start = 0;
  if (decode) start = Math.max(matches.findIndex(item => item.key === decode.key) + 1, 0);
  const slice = matches.slice(start, start + limit);
  if (state.overlap && decode && start && matches[start - 1]) slice.unshift(matches[start - 1]);
  state.overlap = false;
  const last = slice.at(-1);
  const hasMore = start + limit < matches.length;
  return {
    account,
    query,
    sendingEnabled: true,
    total: matches.length,
    limit,
    hasMore,
    nextCursor: hasMore && last
      ? Buffer.from(JSON.stringify({ rank: last.kind === 'chat' ? 1 : 2, sort: last.label.toLowerCase(), key: last.key })).toString('base64url')
      : null,
    contacts: slice,
    sync: {
      identities: items.length,
      matched: matches.length,
      savedNames: 4,
      unmappedLidChats: 0,
      latestSyncAt: '2026-09-27T10:00:00.000Z',
      sources: { contactIdentities: 40, directChatIdentities: 12, groupMemberIdentities: 9 },
      connectorCatalog: { path: '/contacts', used: false, cap: 500, reason: 'Sin paginación.' },
      notices: ['El directorio usa lo que esta cuenta ya sincronizó.'],
    },
  };
}

const fixture = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Cajón</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/contact-directory-ui.css"></head>
<body>
<button id="opener" type="button">Nuevo chat</button>
<script type="module">
import { installContactDirectoryUI } from '/contact-directory-ui.mjs';
const calls = { open: [], start: [], action: [], errors: [] };
window.__calls = calls;
window.addEventListener('error', event => calls.errors.push(event.message));
let account = 'personal';
let epoch = 0;
window.__switch = id => { account = id; epoch += 1; };
async function api(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(\`El servidor respondió \${response.status}.\`);
  return response.json();
}
window.__dir = installContactDirectoryUI({
  api,
  getAccount: () => account,
  getEpoch: () => epoch,
  onOpenChat: async entry => { calls.open.push(entry.key); window.__dir.close(); },
  onStartChat: async entry => { calls.start.push(entry.phone); window.__dir.close(); },
  onAction: action => { calls.action.push(action); window.__dir.close(); },
});
document.querySelector('#opener').onclick = () => window.__dir.open({ opener: document.querySelector('#opener') });
</script></body></html>`;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixture);
  const file = path.resolve(publicDir, `.${pathname}`);
  if (!file.startsWith(`${publicDir}${path.sep}`)) return response.writeHead(403).end();
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome',
});
const page1 = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const offApi = [];
page1.on('request', request => {
  const url = new URL(request.url());
  if (request.method() !== 'GET') state.posts.push(request.url());
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/contacts' && !url.pathname.endsWith('/avatar')) {
    offApi.push(`${request.method()} ${url.pathname}`);
  }
});
await page1.route('**/avatar**', async route => route.fulfill({
  status: 200,
  contentType: 'image/png',
  body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'),
}));
await page1.route('**/api/contacts**', async route => {
  const url = new URL(route.request().url());
  const account = url.searchParams.get('account');
  state.requests.push({ q: url.searchParams.get('q') || '', account });
  if (state.fail) { state.fail = false; return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }); }
  if (state.hold) await state.hold;
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer(account, url.searchParams)) });
});

const dialog = page1.locator('.contact-directory-panel');
const entries = page1.locator('.contact-directory-entry');
const query = page1.locator('#contact-directory-query');
const results = [];

const idle = () => page1.waitForFunction(() => document.querySelector('.contact-directory-panel')?.getAttribute('aria-busy') === 'false');
const requestsFor = account => state.requests.filter(item => item.account === account).length;
async function untilRequests(total) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (state.requests.length >= total) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}
async function open() {
  // The overlay covers the sidebar button, so a drawer left open by the
  // previous check is closed through its own close button first.
  if (await dialog.count()) {
    await page1.locator('.contact-directory-close').click();
    await page1.waitForFunction(() => !document.querySelector('.contact-directory-panel'));
  }
  const before = state.requests.length;
  await page1.locator('#opener').click();
  assert.ok(await untilRequests(before + 1), 'the drawer never asked for its first page');
  await idle();
}
async function search(value, before) {
  await query.fill(value);
  assert.ok(await untilRequests(before + 1), 'the search never reached the server');
  await idle();
}

const check = async (name, run) => {
  try { await run(); results.push(`ok   ${name}`); }
  catch (error) { results.push(`FAIL ${name}: ${String(error?.message).split('\n').slice(0, 6).join(' | ')}`); }
};

await page1.goto(base);

await check('one modal dialog with the real copy', async () => {
  await open();
  assert.equal(await page1.locator('[role=dialog]').count(), 1);
  assert.equal(await dialog.getAttribute('aria-modal'), 'true');
  assert.equal(await page1.locator('#contact-directory-title').textContent(), 'Nuevo chat');
  assert.equal(await page1.locator('.contact-directory-close').getAttribute('aria-label'), 'Cerrar Nuevo chat');
});

await check('the page and its honest status load without any POST', async () => {
  assert.equal(await entries.count(), 60);
  assert.match(await page1.locator('.contact-directory-status').textContent(), /61 identidades sincronizadas/);
  assert.deepEqual(state.posts, []);
});

await check('the three creation actions are offered before browsing', async () => {
  assert.deepEqual(await page1.locator('.contact-directory-action').allTextContents(), ['Nuevo grupo', 'Nuevo contacto', 'Nueva comunidad']);
  assert.deepEqual(await page1.locator('.contact-directory-action').evaluateAll(items => items.map(item => item.dataset.action)), ['group', 'contact', 'community']);
});

await check('one search is debounced into one request and filters', async () => {
  const before = state.requests.length;
  await query.pressSequentially('mar', { delay: 40 });
  assert.ok(await untilRequests(before + 1), 'the search never reached the server');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(state.requests.length, before + 1, `expected one request, got ${state.requests.length - before}`);
  await idle();
  assert.equal(await entries.count(), 1);
  assert.equal(await page1.locator('.contact-directory-entry strong').textContent(), 'María Pilar');
  assert.match(await page1.locator('.contact-directory-entry .contact-directory-detail').textContent(), /Abre el chat existente/);
});

await check('a typed unknown number can still open a chat', async () => {
  await open();
  const before = state.requests.length;
  await query.fill('+34100000097');
  assert.ok(await untilRequests(before + 1));
  await idle();
  const typed = page1.locator('.contact-directory-typed');
  assert.equal(await typed.count(), 1);
  assert.match(await typed.textContent(), /Abrir chat con \+34100000097/);
  assert.equal(await typed.getAttribute('data-kind'), 'typed');
  await typed.click();
  await page1.waitForFunction(() => window.__calls.start.length === 1);
  assert.deepEqual(await page1.evaluate(() => window.__calls.start), ['+34100000097']);
  assert.equal(await dialog.count(), 0, 'starting a chat closes the drawer');
});

await check('a number that matches a loaded contact does not duplicate a row', async () => {
  await open();
  const before = state.requests.length;
  await query.fill('+34600000003');
  assert.ok(await untilRequests(before + 1));
  await idle();
  assert.equal(await page1.locator('.contact-directory-typed').count(), 0);
  assert.equal(await entries.count(), 1);
});

await check('a failed page can be retried without closing', async () => {
  await open();
  const before = state.requests.length;
  state.fail = true;
  await query.fill('contacto 7');
  assert.ok(await untilRequests(before + 1));
  await idle();
  const status = page1.locator('.contact-directory-status');
  assert.equal(await status.getAttribute('data-kind'), 'error');
  assert.match(await status.textContent(), /500/);
  const retry = page1.locator('.contact-directory-retry');
  assert.equal(await retry.isVisible(), true);
  const afterFailure = state.requests.length;
  await retry.click();
  assert.ok(await untilRequests(afterFailure + 1));
  await idle();
  assert.equal(await retry.isVisible(), false);
  assert.ok(await entries.count() > 0, 'the retried page rendered nothing');
  assert.equal(await page1.locator('.contact-directory-status').getAttribute('data-kind'), 'info');
  assert.equal(await dialog.count(), 1, 'retry must not open a second drawer');
});

await check('the next page is appended without repeating a contact', async () => {
  await open();
  state.overlap = true;
  const before = state.requests.length;
  await page1.locator('.contact-directory-more').click({ timeout: 15000 });
  assert.ok(await untilRequests(before + 1), 'the next page was never requested');
  await idle();
  const keys = await entries.evaluateAll(items => items.map(item => item.dataset.key));
  assert.equal(keys.length, 61, `expected 61 rows, got ${keys.length}`);
  assert.equal(new Set(keys).size, 61, `duplicated keys: ${keys.length - new Set(keys).size}`);
  assert.equal(await page1.locator('.contact-directory-more').isVisible(), false);
});

await check('opening an existing chat is local and closes the drawer', async () => {
  await open();
  const postsBefore = state.posts.length;
  await page1.locator('.contact-directory-entry[data-key="34600000007"]').click();
  await page1.waitForFunction(() => window.__calls.open.length === 1);
  assert.deepEqual(await page1.evaluate(() => window.__calls.open), ['34600000007']);
  assert.equal(await dialog.count(), 0);
  assert.equal(state.posts.length, postsBefore, 'opening an existing contact must not POST');
});

await check('a late answer for the previous account never lands', async () => {
  await open();
  let release;
  state.hold = new Promise(resolve => { release = resolve; });
  const before = state.requests.length;
  await query.fill('bea');
  assert.ok(await untilRequests(before + 1), 'the held search was never sent');
  await page1.evaluate(() => window.__switch('secondary'));
  state.hold = null;
  release();
  await page1.waitForFunction(() => [...document.querySelectorAll('.contact-directory-entry')].some(item => item.dataset.key === '34611000001'), null, { timeout: 8000 });
  await idle();
  const keys = await entries.evaluateAll(items => items.map(item => item.dataset.key));
  assert.ok(keys.includes('34611000001'), `secondary row missing: ${keys.join(',')}`);
  assert.ok(!keys.some(key => key.startsWith('3460000')), `stale personal rows: ${keys.join(',')}`);
  assert.match(await page1.locator('.contact-directory-status').textContent(), /2 identidades/);
});

await check('avatars of another account are not rendered', async () => {
  await page1.evaluate(() => window.__switch('personal'));
  await open();
  const sources = await page1.locator('.contact-directory-entry img').evaluateAll(items => items.map(item => item.getAttribute('src')));
  assert.deepEqual(sources, ['/api/chats/personal:34600000003@s.whatsapp.net/avatar?account=personal'],
    `only the same-account avatar may render: ${sources.join(', ')}`);
  assert.ok(!sources.some(src => src.includes('account=secondary')), 'a secondary avatar leaked into personal');
});

await check('Tab stays inside the drawer', async () => {
  const panel = await page1.evaluate(() => {
    const node = document.querySelector('.contact-directory-panel');
    const focusable = [...node.querySelectorAll('button:not([disabled]), input:not([disabled])')].filter(item => !item.closest('[hidden]'));
    const label = element => `${element.tagName}.${element.className || element.id}`;
    focusable.at(-1).focus();
    return { count: focusable.length, first: label(focusable[0]), last: label(focusable.at(-1)) };
  });
  assert.ok(panel.count >= 5, `only ${panel.count} focusable controls`);
  await page1.keyboard.press('Tab');
  assert.equal(await page1.evaluate(() => `${document.activeElement.tagName}.${document.activeElement.className || document.activeElement.id}`),
    panel.first, 'Tab at the last control has to return to the first one');
  await page1.keyboard.press('Shift+Tab');
  assert.equal(await page1.evaluate(() => `${document.activeElement.tagName}.${document.activeElement.className || document.activeElement.id}`),
    panel.last, 'Shift+Tab at the first control has to reach the last one');
});

await check('Escape clears the search first and closes afterwards', async () => {
  await open();
  const before = state.requests.length;
  await query.fill('mar');
  assert.ok(await untilRequests(before + 1));
  await idle();
  await query.press('Escape');
  assert.equal(await dialog.count(), 1, 'the first Escape must only clear the text');
  assert.equal(await query.inputValue(), '');
  await idle();
  await page1.evaluate(() => document.querySelector('.contact-directory-title').setAttribute('tabindex', '-1'));
  await page1.locator('.contact-directory-title').focus();
  await page1.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0, 'Escape outside the search box closes the drawer');
});

await check('the opener regains focus and the actions reach the caller', async () => {
  await open();
  await page1.locator('.contact-directory-close').click();
  assert.equal(await page1.evaluate(() => document.activeElement.id), 'opener');
  await open();
  await page1.locator('.contact-directory-action[data-action="community"]').click();
  assert.deepEqual(await page1.evaluate(() => window.__calls.action), ['community']);
  assert.equal(await dialog.count(), 0);
});

await check('the module never touched another endpoint', async () => {
  assert.deepEqual(offApi, [], `unexpected requests: ${offApi.join(', ')}`);
});

await check('the page reported no runtime error', async () => {
  assert.deepEqual(await page1.evaluate(() => window.__calls.errors), []);
});

await browser.close();
server.close();
console.log(results.join('\n'));
const failed = results.filter(line => line.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
