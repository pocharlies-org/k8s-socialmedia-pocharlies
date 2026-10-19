import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');

const FIXTURE = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/media-library-ui.css"></head>
<body data-theme="dark"><main class="app-shell"><aside class="app-rail"><nav class="rail-top rail-accounts"></nav>
<div class="rail-bottom"></div></aside></main><button id="theft" type="button" style="position:fixed;left:8px;bottom:8px">fuera</button>
<script type="module">
import { installMediaLibraryUI } from '/media-library-ui.mjs';
window.__selected = [];
window.__account = 'alpha';
window.__opens = [];
const api = async (url, data) => {
  const response = await fetch(url, { credentials: 'same-origin', ...(data ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(data)} : {}) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || 'Error del servidor (' + response.status + ').');
  return result;
};
window.__library = installMediaLibraryUI({
  api,
  getAccount: () => window.__account,
  getChats: () => [{id: '123@s.whatsapp.net', name: 'Ana'}, {id: '456@s.whatsapp.net', name: 'Bruno'}],
  selectChat: chat => window.__selected.push(chat),
  onOpen: () => {
    window.__opens.push(document.activeElement?.getAttribute('aria-label') || String(document.activeElement?.tagName));
    document.getElementById('theft').focus();
  },
});
window.__ready = true;
</script></body></html>`;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end(FIXTURE);
  const file = path.resolve(publicDir, `.${pathname}`);
  if (!file.startsWith(`${publicDir}${path.sep}`)) return response.writeHead(403).end();
  try {
    const body = await readFile(file);
    const type = { '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(file)];
    response.writeHead(200, { 'content-type': type || 'application/octet-stream' }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const item = (id, kind, overrides = {}) => ({ id, kind, chatId: '123@s.whatsapp.net', chatName: 'Ana',
  messageId: `w-${id}`, timestamp: '2026-09-20T10:00:00Z', fromMe: false, ...overrides });
const catalog = {
  alpha: {
    media: [
      item('img-1', 'image', { name: 'foto.jpg', url: 'SELF', mimeType: 'image/jpeg' }),
      item('vid-1', 'video', { name: 'clip.mp4', url: 'SELF', mimeType: 'video/mp4', durationSeconds: 95 }),
      item('aud-1', 'audio', { name: 'nota.ogg', url: 'SELF', mimeType: 'audio/ogg', durationSeconds: 42 }),
      item('img-2', 'image', { name: 'pendiente.jpg', url: null }),
      item('img-3', 'image', { name: 'proveedor.jpg', url: 'https://mmgc1.c.us/x.jpg?sig=secret' }),
      item('aud-2', 'audio', { name: 'solo-tuyo.ogg', url: 'SELF', fromMe: true, durationSeconds: 130 }),
    ],
    documents: Array.from({ length: 5 }, (_, index) => item(`doc-${index + 1}`, 'document', { name: `guia-${index + 1}.pdf`, url: 'SELF', mimeType: 'application/pdf' })),
    links: [
      item('link-1', 'link', { text: 'Varias referencias', links: [{ url: 'https://one.example/a', title: 'Uno' }, { url: 'https://two.example/b', title: 'Dos' }] }),
      item('link-2', 'link', { fromMe: true, links: [{ url: 'https://three.example/c', title: 'Tres' }] }),
    ],
  },
  beta: {
    media: [item('beta-1', 'image', { name: 'cuenta-beta.jpg', url: 'SELF' })],
    documents: [item('beta-doc', 'document', { name: 'papeles-beta.pdf', url: 'SELF' })],
    links: [],
  },
};
const PAGE_SIZE = { 'alpha:documents': 2 };
let brokenKey = null;
let slowKey = null;
const blocked = [];
const releaseBlocked = () => { for (const resolve of blocked.splice(0, blocked.length)) resolve(); };
const requests = [];
const mutations = [];
let rejectMutation = false;
let slowMutation = false;
const blockedMutations = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function readContrasts() {
  const parse = value => {
    const parts = value.match(/[\d.]+/g) || [];
    return [Number(parts[0] ?? 0), Number(parts[1] ?? 0), Number(parts[2] ?? 0), parts[3] === undefined ? 1 : Number(parts[3])];
  };
  const rgb = value => value.startsWith('rgb(') || value.startsWith('rgba(');
  const channel = value => { const scaled = value / 255; return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4; };
  const luminance = color => 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
  const composite = (fore, back) => (fore[3] >= 1 ? fore.slice(0, 3) : [0, 1, 2].map(index => fore[index] * fore[3] + back[index] * (1 - fore[3])));
  const backgroundOf = element => {
    for (let node = element; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (rgb(color) && parse(color)[3] >= 0.99) return parse(color).slice(0, 3);
    }
    return [255, 255, 255];
  };
  const probes = {
    pestana: '.media-library-tab.is-active',
    titulo: '.media-library-copy strong',
    autor: '.media-library-meta',
    chat: '.media-library-chat',
    enlace: '.media-library-link:not(.secondary)',
    enlaceSecundario: '.media-library-link.secondary',
    abrir: '.media-library-open',
    noDisponible: '.media-library-unavailable',
    mas: '.media-library-more',
    estado: '.media-library-status',
    filtro: '.media-library-filter-label',
  };
  const ratios = {};
  for (const [name, selector] of Object.entries(probes)) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const background = backgroundOf(element);
    const fore = composite(parse(getComputedStyle(element).color), background);
    const first = luminance(fore);
    const second = luminance(background);
    ratios[name] = Number(((Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)).toFixed(2));
  }
  return ratios;
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (route.request().method() === 'POST') {
    const body = route.request().postDataJSON();
    mutations.push({path: url.pathname, ...body});
    if (slowMutation) await new Promise(resolve => blockedMutations.push(resolve));
    if (rejectMutation) return route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'Proveedor no disponible'})});
    return route.fulfill({contentType: 'application/json', body: JSON.stringify({account: body.account, confirmed: true})});
  }
  if (url.pathname.startsWith('/api/media/')) return route.fulfill({ contentType: 'image/png', body: png });
  if (url.pathname !== '/api/media-library') return route.fulfill({ contentType: 'application/json', body: '{}' });
  const query = Object.fromEntries(url.searchParams);
  const key = `${query.account}:${query.kind}`;
  requests.push(query);
  if (slowKey === key) await new Promise(resolve => { blocked.push(resolve); });
  if (brokenKey === key) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'El servidor no respondió.' }) });
  const all = query.kind === 'all'
    ? Object.values(catalog[query.account] || {}).flat()
    : catalog[query.account]?.[query.kind] || [];
  const haystack = entry => [entry.name, entry.text, ...(entry.links ?? []).map(link => `${link.title ?? ''} ${link.url}`)]
    .filter(Boolean).join(' ').toLowerCase();
  const matching = all.filter(entry => (query.sender === 'me' ? entry.fromMe === true : query.sender === 'others' ? entry.fromMe !== true : true)
    && (!query.q || haystack(entry).includes(query.q.toLowerCase())));
  const ordered = query.order === 'oldest' ? [...matching].reverse()
    : query.order === 'longest' ? [...matching].sort((a, b) => (b.durationSeconds || -1) - (a.durationSeconds || -1)) : matching;
  const offset = Number(query.cursor || 0);
  const size = PAGE_SIZE[key] ?? 50;
  const slice = ordered.slice(offset, offset + size);
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    account: query.account,
    items: slice.map(entry => ({ ...entry, url: entry.url === 'SELF' ? `/api/media/${entry.id}?account=${query.account}&chat=123%40s.whatsapp.net` : entry.url })),
    nextCursor: offset + slice.length < ordered.length ? String(offset + slice.length) : null,
  }) });
});

const panel = page.locator('#media-library-panel');
const list = page.locator('#media-library-list');
const cards = list.locator('.media-library-card');
const status = page.locator('.media-library-status');
const more = page.locator('.media-library-more');
const ids = async () => await cards.evaluateAll(nodes => nodes.map(node => node.dataset.id));
const settle = async () => { await page.waitForFunction(() => document.querySelector('#media-library-panel').getAttribute('aria-busy') === 'false'); await wait(30); };
const openPanel = async () => { await page.locator('#media-library-toggle').click(); await settle(); };
const lastRequest = () => requests[requests.length - 1];
const noProviderLeak = async () => {
  const urls = await list.evaluate(node => [...node.querySelectorAll('img, a')].map(element => element.getAttribute('src') || element.getAttribute('href') || ''));
  assert(urls.every(url => url.startsWith('/api/media/') || /^https?:\/\//.test(url)), `URLes inesperadas: ${urls.join(' ')}`);
  assert(urls.every(url => !/mmgc1|sig=secret/.test(url)), `URLes del proveedor sin filtrar: ${urls.join(' ')}`);
};

// Documentos y Enlaces pintan sobre superficie elevada, donde el texto secundario exige más contraste.
const CONTRAST_TABS = [
  ['Archivos multimedia', ['pestana', 'titulo', 'autor', 'chat', 'noDisponible', 'estado', 'filtro']],
  ['Documentos', ['titulo', 'autor', 'chat', 'abrir']],
  ['Enlaces', ['titulo', 'autor', 'chat', 'enlace', 'enlaceSecundario']],
];
const contrastPass = async label => {
  for (const [tabName, required] of CONTRAST_TABS) {
    await page.getByRole('tab', { name: tabName }).click();
    await settle();
    const ratios = await page.evaluate(readContrasts);
    const missing = required.filter(key => !(key in ratios));
    assert.equal(missing.length, 0, `faltan sondas de contraste en ${tabName} (${label}): ${missing}`);
    const weak = Object.entries(ratios).filter(([, ratio]) => ratio < 4.5);
    assert.equal(weak.length, 0, `contraste inferior a 4.5 en ${tabName} (${label}): ${JSON.stringify(weak)}`);
    console.log(`contrastes ${tabName} ${label}: ${JSON.stringify(ratios)}`);
  }
  await page.getByRole('tab', { name: 'Archivos multimedia' }).click();
  await settle();
};

try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.__ready === true);
  assert.equal(await page.locator('.rail-bottom #media-library-toggle').isVisible(), true);

  await openPanel();
  assert.equal(await page.locator('#media-library-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Cerrar contenido multimedia');
  assert.deepEqual(await page.evaluate(() => window.__opens), ['Contenido multimedia'], 'onOpen avisa al abrir e informa del origen');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Cerrar contenido multimedia',
    'onOpen no puede robar el foco del diálogo');
  assert.deepEqual([lastRequest().account, lastRequest().kind, lastRequest().sender, lastRequest().order, lastRequest().limit], ['alpha', 'media', 'all', 'newest', '50']);
  assert.equal(requests.length, 1, 'abrir el panel hace una única petición');
  assert.deepEqual(await ids(), ['img-1', 'vid-1', 'aud-1', 'img-2', 'img-3', 'aud-2']);
  await noProviderLeak();
  const image = list.locator('.media-library-card[data-id="img-1"] img');
  await image.evaluate(node => node.decode());
  assert.equal(await image.evaluate(node => node.naturalWidth), 1);
  assert.match(await image.getAttribute('src'), /^\/api\/media\/img-1\?account=alpha&chat=/);
  assert.equal(await list.locator('.media-library-card[data-id="img-2"] img').count(), 0);
  assert.equal(await list.locator('.media-library-card[data-id="img-2"]').getByText('Aún no disponible').count(), 1);
  assert.equal(await list.locator('.media-library-card[data-id="img-3"] img').count(), 0);

  await panel.getByRole('button', { name: 'Seleccionar', exact: true }).click();
  const downloadAction = panel.getByRole('button', { name: 'Descargar' });
  assert.equal(await downloadAction.isDisabled(), true);
  await list.getByRole('button', { name: 'Seleccionar foto.jpg' }).click();
  assert.equal(await panel.locator('.media-library-selection-count').textContent(), '1 seleccionado');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Deseleccionar foto.jpg');
  assert.equal(await downloadAction.isEnabled(), true);
  const downloaded = page.waitForEvent('download');
  await downloadAction.click();
  const file = await downloaded;
  assert.equal(file.suggestedFilename(), 'foto.jpg');
  assert.match(file.url(), /\/api\/media\/img-1\?account=alpha/);
  await list.getByRole('button', { name: 'Seleccionar pendiente.jpg' }).click();
  assert.equal(await downloadAction.isDisabled(), true, 'un archivo no disponible no inicia una descarga parcial');
  if (process.env.UI_OUTPUT_DIR) {
    await mkdir(process.env.UI_OUTPUT_DIR, {recursive: true});
    await page.screenshot({path: path.join(process.env.UI_OUTPUT_DIR, 'media-library-select.png')});
  }
  const selectionViewport = page.viewportSize();
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'la barra de selección no desborda el móvil');
  if (process.env.UI_OUTPUT_DIR) await page.screenshot({path: path.join(process.env.UI_OUTPUT_DIR, 'media-library-select-mobile.png')});
  await page.setViewportSize(selectionViewport);
  rejectMutation = true;
  await panel.getByRole('button', { name: 'Destacar' }).click();
  await page.waitForFunction(() => document.querySelector('.media-library-status')?.textContent.includes('Proveedor no disponible'));
  assert.equal(await panel.locator('.media-library-selection-count').textContent(), '2 seleccionados');
  rejectMutation = false;
  await panel.getByRole('button', { name: 'Destacar' }).click();
  await page.waitForFunction(() => document.querySelector('.media-library-selection-count')?.textContent === '0 seleccionados');
  assert.deepEqual(mutations.filter(item => item.path === '/api/chat-actions').map(item => [item.account, item.chat, item.messageId, item.action]),
    [['alpha', '123@s.whatsapp.net', 'w-img-1', 'starred'], ['alpha', '123@s.whatsapp.net', 'w-img-1', 'starred'], ['alpha', '123@s.whatsapp.net', 'w-img-2', 'starred']]);
  await list.getByRole('button', { name: 'Seleccionar clip.mp4' }).click();
  await panel.getByRole('button', { name: 'Reenviar mensajes' }).click();
  await panel.getByRole('combobox', { name: 'Conversación de destino' }).selectOption('456@s.whatsapp.net');
  await panel.getByRole('button', { name: 'Reenviar', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.media-library-selection-count')?.textContent === '0 seleccionados');
  assert.deepEqual(mutations.filter(item => item.path === '/api/messages/forward').map(item => [item.account, item.chat, item.messageId, item.targetChat]),
    [['alpha', '123@s.whatsapp.net', 'w-vid-1', '456@s.whatsapp.net']]);
  await panel.getByRole('button', { name: 'Cancelar' }).click();
  assert.equal(await panel.locator('.media-library-selection-bar').isHidden(), true);
  assert.equal(await list.locator('.media-library-select').count(), 0);

  await list.locator('.media-library-card[data-id="vid-1"] .media-library-tile').click();
  const previewMedia = panel.locator('.media-library-preview video');
  assert.equal(await previewMedia.evaluate(node => node.controls && node.preload === 'none'), true);
  assert.match(await previewMedia.getAttribute('src'), /^\/api\/media\/vid-1/);
  await panel.getByRole('button', { name: 'Cerrar vista previa' }).click();
  assert.equal(await panel.locator('.media-library-preview').isHidden(), true);
  await list.locator('.media-library-card[data-id="img-1"] .media-library-tile').click();
  const previewImage = panel.locator('.media-library-preview img');
  await previewImage.evaluate(node => node.decode());
  assert.match(await previewImage.getAttribute('src'), /^\/api\/media\/img-1/);
  assert.equal(await panel.locator('.media-library-preview-chat').isVisible(), true);
  if (process.env.UI_OUTPUT_DIR) {
    await mkdir(process.env.UI_OUTPUT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.UI_OUTPUT_DIR, 'media-library-preview.png') });
  }
  await page.keyboard.press('Escape');
  assert.equal(await panel.locator('.media-library-preview').isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Cerrar contenido multimedia',
    'Escape en la vista previa devuelve el foco al diálogo');

  await list.locator('.media-library-card[data-id="aud-1"] .media-library-chat').click();
  assert.deepEqual(await page.evaluate(() => window.__selected), [{ id: '123@s.whatsapp.net', name: 'Ana', messageId: 'w-aud-1' }]);
  assert.equal(await panel.isHidden(), true);
  assert.equal(await page.evaluate(() => window.__opens.length), 1, 'cerrar no reabre otros diálogos');
  await openPanel();
  assert.equal(await page.evaluate(() => window.__opens.length), 2, 'cada apertura avisar al host');
  assert.deepEqual(await ids(), ['img-1', 'vid-1', 'aud-1', 'img-2', 'img-3', 'aud-2'], 'al reabrir se recarga la pestaña activa');
  await page.getByLabel('Ordenar').selectOption('longest');
  await settle();
  assert.equal(lastRequest().order, 'longest');
  assert.deepEqual(await ids(), ['aud-2', 'vid-1', 'aud-1', 'img-1', 'img-2', 'img-3']);
  assert.match(await list.locator('.media-library-card[data-id="aud-2"] .media-library-meta').textContent(), /2:10/);
  await page.getByLabel('Ordenar').selectOption('newest');
  await settle();

  await page.getByRole('tab', { name: 'Documentos' }).click();
  await settle();
  assert.equal(lastRequest().kind, 'documents');
  assert.equal(await page.locator('option[value="longest"]').isHidden(), true, 'duration ordering is only offered for media');
  assert.deepEqual(await ids(), ['doc-1', 'doc-2']);
  assert.equal(await list.locator('img').count(), 0, 'un documento no se precarga como imagen');
  assert.match(await list.locator('.media-library-open').first().getAttribute('href'), /^\/api\/media\/doc-1\?account=alpha/);
  assert.equal(await more.isVisible(), true);
  await more.click();
  await settle();
  assert.equal(lastRequest().cursor, '2');
  assert.deepEqual(await ids(), ['doc-1', 'doc-2', 'doc-3', 'doc-4']);
  await more.click();
  await settle();
  assert.equal(await more.isHidden(), true, 'sin cursor no se ofrece más paginación');
  assert.equal(await cards.count(), 5);

  await page.getByRole('tab', { name: 'Enlaces' }).click();
  await settle();
  assert.deepEqual(await list.locator('.media-library-card[data-id="link-1"] .media-library-link').evaluateAll(nodes => nodes.map(node => [node.getAttribute('href'), node.getAttribute('rel'), node.textContent])),
    [['https://one.example/a', 'noopener noreferrer', 'Uno'], ['https://two.example/b', 'noopener noreferrer', 'Dos']]);
  const linkBox = await cards.first().boundingBox();
  assert(linkBox && linkBox.height > 40 && linkBox.width > 220, 'las tarjetas de enlaces colapsan');
  await page.getByLabel('Filtrar por autor').selectOption('me');
  await settle();
  assert.equal(lastRequest().sender, 'me');
  assert.deepEqual(await ids(), ['link-2']);
  await page.getByLabel('Filtrar por autor').selectOption('all');
  await settle();
  await page.getByLabel('Ordenar').selectOption('oldest');
  await settle();
  assert.equal(lastRequest().order, 'oldest');
  assert.deepEqual(await ids(), ['link-2', 'link-1'], 'el orden inverso se aplica a la lista');
  await panel.getByRole('button', {name: 'Buscar', exact: true}).click();
  assert.equal(await panel.getByRole('tab', {name: 'Enlaces'}).isHidden(), true);
  await page.getByLabel('Buscar contenido multimedia').fill('guia');
  await wait(420);
  await settle();
  assert.deepEqual(await ids(), ['doc-5', 'doc-4', 'doc-3', 'doc-2', 'doc-1'], 'buscar desde Enlaces también encuentra Documentos');
  const searchViewport = page.viewportSize();
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'la búsqueda global no desborda el móvil');
  if (process.env.UI_OUTPUT_DIR) await page.screenshot({path: path.join(process.env.UI_OUTPUT_DIR, 'media-library-search-mobile.png')});
  await page.setViewportSize(searchViewport);
  await page.getByLabel('Buscar contenido multimedia').fill('foto');
  await wait(420);
  await settle();
  assert.deepEqual(await ids(), ['img-1'], 'buscar desde Enlaces también encuentra multimedia');
  await page.getByLabel('Buscar contenido multimedia').fill('tres');
  await wait(420);
  await settle();
  assert.equal(lastRequest().kind, 'all', 'la búsqueda no queda limitada a la pestaña previa');
  assert.equal(lastRequest().q, 'tres');
  assert.deepEqual(await ids(), ['link-2']);
  await page.getByLabel('Buscar contenido multimedia').fill('nada-de-esto');
  await wait(420);
  await settle();
  assert.deepEqual(await ids(), []);
  assert.equal(await status.getAttribute('data-kind'), 'empty');
  assert.match(await status.textContent(), /No hay resultados/);
  assert.equal(await more.isHidden(), true);
  await page.getByLabel('Buscar contenido multimedia').fill('');
  await wait(420);
  await settle();
  assert.equal(lastRequest().kind, 'links', 'sin término se conserva la pestaña de origen');
  await panel.getByRole('button', {name: 'Cerrar búsqueda'}).click();
  await settle();
  assert.equal(await panel.getByRole('tab', {name: 'Enlaces'}).isVisible(), true);
  await page.getByLabel('Ordenar').selectOption('newest');
  await settle();
  assert.deepEqual(await ids(), ['link-1', 'link-2']);

  // A -> B -> A: la respuesta lenta y fallida de la pestaña anterior no mezcla resultados.
  slowKey = 'alpha:documents';
  brokenKey = 'alpha:documents';
  await page.getByRole('tab', { name: 'Documentos' }).click();
  await page.getByRole('tab', { name: 'Archivos multimedia' }).click();
  await settle();
  assert.equal(requests.filter(request => request.kind === 'documents').length > 1, true, 'la petición de documentos quedó pendiente');
  releaseBlocked();
  await wait(150);
  assert.deepEqual(await ids(), ['img-1', 'vid-1', 'aud-1', 'img-2', 'img-3', 'aud-2']);
  assert.equal(await status.getAttribute('data-kind'), '');
  assert.equal(await more.isHidden(), true);
  await noProviderLeak();
  slowKey = null;
  brokenKey = null;
  await settle();

  brokenKey = 'alpha:links';
  await page.getByRole('tab', { name: 'Enlaces' }).click();
  await settle();
  assert.match(await status.textContent(), /El servidor no respondió/);
  assert.equal(await status.getAttribute('data-kind'), 'error');
  assert.equal(await page.locator('.media-library-retry').isVisible(), true);
  assert.deepEqual(await ids(), [], 'un fallo no se muestra como un vacío');
  brokenKey = null;
  await page.locator('.media-library-retry').click();
  await settle();
  assert.deepEqual(await ids(), ['link-1', 'link-2']);
  assert.equal(await status.getAttribute('data-kind'), '');

  // Un error que llega después de cerrar no puede aparecer al reabrir la misma cuenta.
  slowKey = 'alpha:links';
  brokenKey = 'alpha:links';
  await page.getByLabel('Filtrar por autor').selectOption('others');
  await page.getByRole('button', { name: 'Cerrar contenido multimedia' }).click();
  releaseBlocked();
  await wait(150);
  slowKey = null;
  brokenKey = null;
  await openPanel();
  assert.deepEqual(await ids(), ['link-1']);
  assert.equal(await status.getAttribute('data-kind'), '');
  assert.equal(await page.locator('.media-library-retry').isHidden(), true);
  await page.getByLabel('Filtrar por autor').selectOption('all');
  await settle();

  // Cambio de cuenta: se descartan elementos y respuestas de la cuenta anterior.
  slowKey = 'alpha:links';
  await page.getByLabel('Filtrar por autor').selectOption('others');
  await page.evaluate(() => { window.__account = 'beta'; window.__library.accountChanged(); });
  await settle();
  assert.equal(lastRequest().account, 'beta');
  assert.deepEqual(await ids(), [], 'la cuenta nueva empieza vacía');
  releaseBlocked();
  await wait(150);
  assert.deepEqual(await ids(), [], 'una respuesta de la cuenta anterior no reaparece');
  slowKey = null;
  await page.getByRole('tab', { name: 'Documentos' }).click();
  await settle();
  assert.deepEqual(await ids(), ['beta-doc']);
  await page.getByRole('tab', { name: 'Archivos multimedia' }).click();
  await settle();
  assert.deepEqual(await ids(), ['beta-1']);
  await panel.getByRole('button', { name: 'Seleccionar', exact: true }).click();
  await list.getByRole('button', { name: 'Seleccionar cuenta-beta.jpg' }).click();
  assert.equal(await panel.locator('.media-library-selection-count').textContent(), '1 seleccionado');
  await page.evaluate(() => { window.__account = 'alpha'; window.__library.accountChanged(); });
  await settle();
  assert.equal(await panel.locator('.media-library-selection-count').textContent(), '0 seleccionados');
  await panel.getByRole('button', { name: 'Cancelar' }).click();
  await noProviderLeak();

  for (const [width, height, theme] of [[1280, 800, 'light'], [1280, 800, 'dark'], [390, 844, 'light'], [390, 844, 'dark']]) {
    if (width === 1280 && theme === 'light') {
      await page.evaluate(() => { window.__account = 'alpha'; window.__library.accountChanged(); });
      await settle();
      await page.getByLabel('Filtrar por autor').selectOption('all');
      await settle();
      assert.deepEqual(await ids(), ['img-1', 'vid-1', 'aud-1', 'img-2', 'img-3', 'aud-2']);
    }
    await page.setViewportSize({ width, height });
    await page.evaluate(value => { document.body.dataset.theme = value; }, theme);
    await wait(60);
    const railWidth = await page.locator('.app-rail').evaluate(node => node.getBoundingClientRect().width);
    const shade = await page.locator('.media-library-overlay').boundingBox();
    assert(shade && Math.abs(shade.y) <= 1 && Math.abs(shade.height - height) <= 1, `el backdrop no cubre el alto en ${width} ${theme}`);
    if (width >= 761) {
      assert(Math.abs(shade.x - railWidth) <= 1 && Math.abs(shade.width - (width - railWidth)) <= 1,
        `el backdrop debe dejar el rail libre en ${width} ${theme}: x=${Math.round(shade.x)} w=${Math.round(shade.width)} rail=${railWidth}`);
      assert.equal(await page.evaluate(() => {
        const toggle = document.querySelector('#media-library-toggle');
        const rect = toggle.getBoundingClientRect();
        return toggle.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), true, `el rail debe seguir clicable con el modal abierto en ${width} ${theme}`);
    } else {
      assert(Math.abs(shade.x) <= 1 && Math.abs(shade.width - width) <= 1, `en móvil el backdrop cubre toda la pantalla en ${width} ${theme}`);
    }
    const box = await panel.boundingBox();
    assert(box, 'el panel debe estar visible');
    if (width >= 761) {
      assert(Math.abs(box.width - width * 0.8) <= 2 && Math.abs(box.height - height * 0.8) <= 2,
        `el modal debe ocupar el 80% de la pantalla en ${width}x${height}: ${Math.round(box.width)}x${Math.round(box.height)}`);
      assert(Math.abs(box.x - (shade.x + (shade.width - box.width) / 2)) <= 2 && Math.abs(box.y - (height - box.height) / 2) <= 2,
        `el modal debe centrarse en el área de contenido en ${width} ${theme}`);
    } else {
      assert(Math.abs(box.width - width) <= 1 && Math.abs(box.height - height) <= 1, `en móvil el modal ocupa toda la pantalla en ${width} ${theme}`);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 0, `desbordamiento horizontal de ${overflow}px en ${width} ${theme}`);
    const tabs = await page.locator('.media-library-tab').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
    assert(tabs.length === 3 && tabs.every(size => size > 28), `las pestañas se encogen en ${width} ${theme}`);
    const columns = await page.evaluate(() => new Set([...document.querySelectorAll('#media-library-list .media-library-tile')]
      .map(tile => Math.round(tile.getBoundingClientRect().x))).size);
    assert(columns === (width >= 761 ? 5 : 3), `la cuadrícula multimedia debe usar ${width >= 761 ? 5 : 3} columnas, ${columns} en ${width} ${theme}`);
    const boxes = await cards.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()));
    assert(boxes.length > 0 && boxes.every(box => box.height > 24 && box.width > 60), `las tarjetas colapsan en ${width} ${theme}`);
    assert(boxes.every(box => box.x >= -1 && box.x + box.width <= width + 1), `tarjetas fuera del panel en ${width} ${theme}`);
    await contrastPass(`${theme} ${width}px`);
    if (process.env.UI_OUTPUT_DIR) {
      await mkdir(process.env.UI_OUTPUT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.UI_OUTPUT_DIR, `media-library-${width}-${theme}.png`) });
    }
  }
  await panel.getByRole('button', { name: 'Seleccionar', exact: true }).click();
  await list.getByRole('button', { name: 'Seleccionar pendiente.jpg' }).click();
  await panel.getByRole('button', { name: 'Eliminar', exact: true }).click();
  assert.equal(await panel.getByRole('button', { name: 'Eliminar para todos' }).isDisabled(), true);
  await panel.getByRole('button', { name: 'Eliminar para mí' }).click();
  await page.waitForFunction(() => !document.querySelector('.media-library-card[data-id="img-2"]'));
  assert.deepEqual(mutations.filter(item => item.path === '/api/messages/delete').map(item => [item.account, item.chat, item.messageId, item.scope]),
    [['alpha', '123@s.whatsapp.net', 'w-img-2', 'me']]);
  slowMutation = true;
  await list.getByRole('button', { name: 'Seleccionar foto.jpg' }).click();
  await panel.getByRole('button', { name: 'Destacar' }).click();
  await page.waitForFunction(() => document.querySelector('#media-library-panel')?.getAttribute('aria-busy') === 'true');
  for (let attempt = 0; attempt < 50 && !blockedMutations.length; attempt++) await wait(10);
  assert.equal(blockedMutations.length, 1, 'la mutación anterior está realmente en vuelo');
  await page.evaluate(() => { window.__account = 'beta'; window.__library.accountChanged(); });
  await settle();
  for (const release of blockedMutations.splice(0)) release();
  slowMutation = false;
  await wait(80);
  assert.deepEqual(await ids(), ['beta-1'], 'el resultado antiguo no modifica la biblioteca de otra cuenta');
  assert.equal(await panel.locator('.media-library-selection-count').textContent(), '0 seleccionados');
  assert.equal(await status.textContent(), '');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', requests: requests.length, accounts: ['alpha', 'beta'], syntheticMutations: mutations.length, liveMutations: 0 }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
