#!/usr/bin/env node
/*
 * Contrato de navegador del visor de Novedades: los estados se abren por autor
 * (nunca /status sin author), la paginación usa el cursor del proxy, el TTL se
 * calcula con remainingMs, y la búsqueda de canales es local sin parametro q.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const requests = [];
const pageErrors = [];
let releaseFirstPost;
const firstPostGate = new Promise(resolve => { releaseFirstPost = resolve; });
const iso = hoursAgo => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const statusItem = (id, hoursAgo) => ({ id, author: '34600111222@c.us', text: `estado ${id}`, kind: 'text', timestamp: iso(hoursAgo), timestampMs: Date.now() - hoursAgo * 3_600_000, expiresAt: new Date(Date.now() + 630_000).toISOString(), remainingMs: 630_000, active: true, freshnessUnknown: false, deleted: false, mediaUrl: null, mimeType: null, mediaKind: null, seenAt: null });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture.local');
  if (url.pathname.startsWith('/api/')) {
    const call = { path: url.pathname, search: url.search, method: request.method };
    if (request.method === 'POST') call.body = JSON.parse(await new Promise((resolve, reject) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => resolve(raw));
      request.on('error', reject);
    }));
    requests.push(call);
    let data = {};
    if (url.pathname === '/api/accounts') data = { accounts: [{ id: 'alpha', label: 'Alpha' }], sendingEnabled: true };
    if (url.pathname === '/api/chats') data = { chats: [], hasMore: false, nextCursor: null };
    if (url.pathname === '/api/novedades/status/authors') data = { account: 'alpha', hasMore: false, nextCursor: null, coverage: {}, authors: [
      { id: '34600111222@c.us', name: 'Ana', own: false, count: 3, total: 3, unseen: 2, latestTimestamp: iso(1) },
      { id: '34600999888@c.us', name: null, own: true, count: 1, total: 1, unseen: 0, latestTimestamp: iso(2) },
    ] };
    if (url.pathname === '/api/novedades/status') {
      const page2 = url.searchParams.get('cursor') === 'p2';
      data = { account: 'alpha', hasMore: !page2, nextCursor: page2 ? null : 'p2', coverage: {}, serverTime: iso(0), items: page2 ? [statusItem('t0', 30)] : [statusItem('t2', 1), statusItem('t1', 6)] };
    }
    if (url.pathname === '/api/novedades/channels') data = { account: 'alpha', hasMore: false, nextCursor: null, coverage: {}, channels: [
      { id: '111@newsletter', name: 'Beta', description: null, subscribers: 5, avatarAvailable: false, latestTimestamp: null },
      { id: '222@newsletter', name: 'Gamma', description: null, subscribers: null, avatarAvailable: false, latestTimestamp: null },
    ] };
    if (url.pathname === '/api/novedades/channels/lookup') data = { account: 'alpha', channel: {
      id: '333@newsletter', name: 'Canal encontrado', description: 'Desde enlace',
      role: 'guest', subscribed: false, verification: 'verified', subscribers: 12,
      createdAt: iso(24), muted: false, avatarAvailable: false, avatarUrl: null,
    } };
    if (url.pathname === '/api/novedades/channels/subscription' && request.method === 'POST') {
      data = {
        account: 'alpha',
        action: call.body.action,
        confirmed: call.body.action === 'follow',
        channel: {
          id: call.body.jid, name: 'Canal encontrado',
          role: call.body.action === 'follow' ? 'subscriber' : 'subscriber',
          subscribed: true, subscribers: 12, avatarAvailable: false,
        },
      };
    }
    if (url.pathname === '/api/novedades/channels/111%40newsletter/posts') {
      await firstPostGate;
      data = {account:'alpha', hasMore:false, nextCursor:null, coverage:{}, items:[{id:'old-post', kind:'text', text:'Publicación del canal anterior', timestamp:iso(1)}]};
    }
    if (url.pathname === '/api/novedades/channels/222%40newsletter/posts') {
      data = {account:'alpha', hasMore:false, nextCursor:null, coverage:{}, items:[{id:'current-post', kind:'text', text:'Publicación del canal actual', timestamp:iso(1)}]};
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    return;
  }
  const file = path.resolve(publicDir, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(`${publicDir}${path.sep}`)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)];
    response.writeHead(200, { 'content-type': type || 'application/octet-stream' }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome', args: ['--no-sandbox'] });
try {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  tab.on('pageerror', error => pageErrors.push(error.message));
  await tab.goto(`http://127.0.0.1:${server.address().port}`);
  await tab.locator('[data-account-id="alpha"]').waitFor();
  await tab.getByRole('button', { name: 'Estados', exact: true }).click();
  await tab.waitForFunction(() => document.querySelector('.novedades-panel')?.getAttribute('aria-busy') === 'false');
  await tab.getByRole('button', { name: 'Ana', exact: true }).click();
  await tab.getByText('estado t2').waitFor();
  const statusCalls = requests.filter(item => item.path === '/api/novedades/status');
  assert.equal(statusCalls.length, 1, 'one author opens exactly one statuses request');
  assert(new URLSearchParams(statusCalls[0].search).get('author') === '34600111222@c.us');
  assert(!statusCalls.some(item => !new URLSearchParams(item.search).get('author')));
  assert(await tab.getByText('1 de 2').isVisible());
  assert(await tab.getByText('Caduca en 10 min').first().isVisible(), 'TTL comes from remainingMs');
  assert(new URLSearchParams(statusCalls[0].search).get('q') === null);
  await tab.getByRole('button', { name: 'Estado siguiente' }).click();
  assert(await tab.getByText('2 de 2').isVisible());
  await tab.getByRole('button', { name: 'Estado siguiente' }).click();
  await tab.getByText('estado t0').waitFor();
  const page2Call = requests.filter(item => item.path === '/api/novedades/status').at(-1);
  assert(new URLSearchParams(page2Call.search).get('cursor') === 'p2', 'the next step consumes the proxy cursor');
  assert(await tab.getByText('3 de 3').isVisible());
  await tab.getByRole('button', {name: 'Cerrar visor'}).click();
  assert.equal(await tab.locator('.novedades-overlay').count(), 0, 'viewer close removes the panel');
  await tab.getByRole('button', {name: 'Estados', exact: true}).click();
  await tab.waitForFunction(() => document.querySelector('.novedades-panel')?.getAttribute('aria-busy') === 'false');
  await tab.getByRole('button', {name: 'Ana', exact: true}).click();
  await tab.getByText('estado t2').waitFor();
  await tab.keyboard.press('Escape');
  assert.equal(await tab.evaluate(() => document.querySelector('.novedades-viewer')?.isConnected), undefined, 'Escape closes only the viewer');
  assert.equal(await tab.locator('.novedades-row').first().isVisible(), true);
  await tab.keyboard.press('Escape');
  assert.equal(await tab.evaluate(() => document.querySelector('.novedades-panel')), null);
  await tab.getByRole('button', {name: 'Estados', exact: true}).click();
  await tab.getByRole('button', {name: 'Cerrar Novedades'}).click();
  assert.equal(await tab.locator('.novedades-overlay').count(), 0, 'header close removes the panel');
  await tab.getByRole('button', {name: 'Estados', exact: true}).click();
  await tab.locator('.novedades-overlay').click({position:{x:5,y:5}});
  assert.equal(await tab.locator('.novedades-overlay').count(), 0, 'backdrop click removes the panel');
  const expiry = await tab.evaluate(async () => {
    const { installNovedadesUI } = await import('/novedades-ui.mjs');
    let now = 0;
    let tick;
    const item = (id, remainingMs) => ({ id, author: 'author@c.us', kind: 'text', text: id, timestamp: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), remainingMs, active: true, freshnessUnknown: false, deleted: false });
    const ui = installNovedadesUI({
      documentRef: document,
      windowRef: { location, performance: { now: () => now }, setInterval: callback => { tick = callback; return 1; }, clearInterval: () => {} },
      getAccount: () => 'alpha',
      loadAuthors: async () => ({ authors: [{ id: 'author@c.us', name: 'Fixture', count: 2, unseen: 2 }] }),
      loadStatuses: async () => ({ items: [item('short', 1000), item('long', 5000)] }),
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    ui.open({ opener: document.querySelector('[data-account-id="alpha"]') });
    await settle();
    document.querySelector('.novedades-row').click();
    await settle();
    now = 1000;
    document.querySelector('[aria-label="Estado siguiente"]').click();
    const navigation = document.querySelector('.novedades-viewer-media')?.textContent;
    document.querySelector('[aria-label="Volver a la lista de estados"]').click();
    now = 0;
    document.querySelector('.novedades-row').click();
    await settle();
    now = 1000;
    tick();
    const ticker = document.querySelector('.novedades-viewer-media')?.textContent;
    document.querySelector('[aria-label="Estado siguiente"]').focus();
    now = 5000;
    tick();
    const closed = !document.querySelector('.novedades-viewer');
    const focusRestored = document.activeElement === document.querySelector('.novedades-list');
    ui.close();
    return { navigation, ticker, closed, focusRestored };
  });
  assert.deepEqual(expiry, { navigation: 'long', ticker: 'long', closed: true, focusRestored: true }, 'navigation and ticker remove expired content and restore list focus');
  await tab.getByRole('button', { name: 'Canales', exact: true }).click();
  await tab.waitForFunction(() => document.querySelector('.novedades-panel')?.getAttribute('aria-busy') === 'false');
  const channelsBefore = requests.filter(item => item.path === '/api/novedades/channels').length;
  await tab.getByLabel('Buscar canales').fill('beta');
  assert.equal(await tab.locator('.novedades-row strong').count(), 1);
  assert.equal(await tab.locator('.novedades-row strong').first().textContent(), 'Beta');
  assert.equal(requests.filter(item => item.path === '/api/novedades/channels').length, channelsBefore, 'channel search never round-trips');
  await tab.getByLabel('Buscar canales').fill('');
  const firstRequest = tab.waitForRequest(request => request.url().includes('/api/novedades/channels/111%40newsletter/posts'));
  await tab.locator('.novedades-row').filter({hasText:'Beta'}).click();
  await firstRequest;
  await tab.getByRole('button', {name:'Volver a la lista de canales'}).click();
  await tab.locator('.novedades-row').filter({hasText:'Gamma'}).click();
  await tab.getByText('Publicación del canal actual').waitFor();
  const staleResponse = tab.waitForResponse(response => response.url().includes('/api/novedades/channels/111%40newsletter/posts'));
  releaseFirstPost();
  await staleResponse;
  await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await tab.getByText('Publicación del canal anterior').count(), 0, 'late previous channel cannot replace current posts');
  await tab.getByRole('button', { name: 'Volver a la lista de canales' }).click();
  await tab.getByLabel('Buscar canales').fill('https://whatsapp.com/channel/InviteCode');
  await tab.getByRole('button', { name: 'Consultar en WhatsApp' }).click();
  await tab.getByText('Canal encontrado').waitFor();
  assert(new URLSearchParams(requests.filter(item => item.path === '/api/novedades/channels/lookup').at(-1).search).get('account') === 'alpha');
  const openFound = tab.getByRole('button', { name: 'Abrir canal encontrado' });
  await openFound.click();
  await tab.getByText('Este canal todavía no tiene publicaciones sincronizadas.').waitFor();
  await tab.getByRole('button', { name: 'Volver a la lista de canales' }).click();
  tab.once('dialog', dialog => dialog.accept());
  await tab.getByRole('button', { name: 'Seguir canal' }).click();
  await tab.getByRole('button', { name: 'Dejar de seguir' }).waitFor();
  const follow = requests.filter(item => item.path === '/api/novedades/channels/subscription').at(-1);
  assert.equal(follow.method, 'POST');
  assert.deepEqual(follow.body, { account: 'alpha', jid: '333@newsletter', action: 'follow' });
  tab.once('dialog', dialog => dialog.accept());
  await tab.getByRole('button', { name: 'Dejar de seguir' }).click();
  await tab.getByText(/WhatsApp no confirmó el cambio/).waitFor();
  assert.equal(await tab.getByRole('button', { name: 'Dejar de seguir' }).count(), 1, 'unconfirmed leave never changes the UI state');
  assert(requests.every(item => !new URLSearchParams(item.search).has('q')));
  assert(requests.every(item => item.path === '/api/chats' || !new URLSearchParams(item.search).has('q')));
  await tab.keyboard.press('Escape');
  assert.deepEqual(pageErrors, [], 'no page errors');
  const mobile = await browser.newPage({viewport:{width:390,height:844}});
  mobile.on('pageerror', error => pageErrors.push(error.message));
  await mobile.goto(`http://127.0.0.1:${server.address().port}`);
  await mobile.locator('[data-account-id="alpha"]').waitFor();
  await mobile.getByRole('button',{name:'Estados',exact:true}).click();
  const closeButton = mobile.getByRole('button',{name:'Cerrar Novedades'});
  const bounds = await closeButton.boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 390, 'mobile close button stays inside viewport');
  await mobile.keyboard.press('Tab');
  assert(await mobile.locator('.novedades-panel').evaluate(panel => panel.contains(document.activeElement)), 'focus stays inside dialog');
  await closeButton.focus();
  await mobile.keyboard.press('Shift+Tab');
  assert(await mobile.locator('.novedades-panel').evaluate(panel => panel.contains(document.activeElement)), 'reverse focus stays inside dialog');
  await closeButton.click();
  assert.equal(await mobile.locator('.novedades-overlay').count(),0);
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('Novedades UI: author-first pages, local/external channel lookup, subscription confirmation and local channel search pass');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
