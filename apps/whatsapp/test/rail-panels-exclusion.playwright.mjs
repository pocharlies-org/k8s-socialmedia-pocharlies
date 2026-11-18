#!/usr/bin/env node
/*
 * Contrato de navegador aislado: los paneles del rail (biblioteca, comunidades,
 * perfil, ajustes, panel IA) son mutuamente excluyentes con ratón y con teclado,
 * y Escape cierra el unico dialogo abierto devolviendo el foco a su toggle.
 * Arranca la app real (public/app.js) con todas las rutas /api servidas por fixture.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const playwrightModule = process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightModule);
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome';
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const profile = { name: 'Ana Fixture', about: 'Disponible', photo: { available: false } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
const routes = {
  '/api/accounts': () => ({ accounts: [{ id: 'alpha', label: 'Alpha' }], sendingEnabled: true, outboxScope: 'alpha' }),
  '/api/chats': () => ({ chats: [{ id: '123@s.whatsapp.net', name: 'Ana Fixture', preview: 'Hola', unread: 0, isGroup: false }] }),
  '/api/messages': () => ({ messages: [] }),
  '/api/messages/pins': url => ({ account: url.searchParams.get('account'), chat: url.searchParams.get('chat'), items: [] }),
  '/api/communities': () => ({ account: 'alpha', communities: [] }),
  '/api/media-library': url => ({
    account: url.searchParams.get('account'),
    items: [{ id: 'img-1', kind: 'image', chatId: '123@s.whatsapp.net', chatName: 'Ana Fixture', messageId: 'w-1',
      timestamp: '2026-09-20T10:00:00Z', fromMe: false, name: 'foto.jpg', mimeType: 'image/jpeg',
      url: `/api/media/img-1?account=${url.searchParams.get('account')}` }],
    nextCursor: null,
  }),
  '/api/profile': url => ({ account: url.searchParams.get('account'), profile }),
  '/api/contacts': url => ({ account: url.searchParams.get('account'), contacts: [], sendingEnabled: true, nextCursor: null }),
  '/api/lists': () => ({ lists: [] }),
  '/api/presence': () => ({ presence: {} }),
  '/api/presence/subscribe': () => ({ confirmed: true }),
};
const unexpected = [];

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://fixture.local');
  if (url.pathname.startsWith('/api/media/')) {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'no-store' }).end(png);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    const handler = routes[url.pathname];
    if (!handler) unexpected.push(url.pathname);
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(handler ? handler(url) : {}));
    return;
  }
  const file = path.resolve(publicDir, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(`${publicDir}${path.sep}`)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(file)];
    response.writeHead(200, { 'content-type': type || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));

let checks = 0;
const check = name => { checks += 1; console.log(`ok ${checks} - ${name}`); };

const states = () => page.evaluate(() => ({
  library: !document.querySelector('.media-library-overlay')?.hidden,
  communities: !document.querySelector('.communities-shade')?.hidden,
  profile: !document.getElementById('profile-panel')?.hidden,
  settings: Boolean(document.querySelector('.rail-settings')?.open),
  ai: !document.getElementById('ai-panel')?.hidden,
}));
const openPanels = async () => Object.entries(await states()).filter(([, open]) => open).map(([name]) => name);
// El evento toggle de <details> se despacha como tarea: se espera a que el estado se asiente antes de afirmar.
async function settledOpenPanels(expected, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let current = await openPanels();
  while (Date.now() < deadline && JSON.stringify(current) !== JSON.stringify(expected)) {
    await new Promise(resolve => setTimeout(resolve, 50));
    current = await openPanels();
  }
  return current;
}
const assertOnly = async name => assert.deepEqual(await settledOpenPanels([name]), [name], `se esperaba solo ${name} abierto`);
const assertNone = async () => assert.deepEqual(await settledOpenPanels([]), [], 'se esperaba ningun panel abierto');
const activeId = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);

await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('media-library-toggle')
  && document.getElementById('communities-toggle') && document.getElementById('profile-toggle'), null, { timeout: 15000 });
await page.waitForFunction(() => document.querySelector('#account option'), null, { timeout: 15000 });

await assertNone();
check('al cargar no hay ningun panel del rail abierto');

const blockingWhenClosed = await page.evaluate(async () => (await import('/features-ui.mjs')).hasOpenBlockingDialog(document));
assert.equal(blockingWhenClosed, false, 'sin paneles abiertos no puede haber un dialogo bloqueante');
check('hasOpenBlockingDialog es false con todo cerrado (los atajos de teclado siguen vivos)');

await page.click('.rail-settings summary');
await assertOnly('settings');
check('el popover de ajustes se abre solo');
await page.click('#media-library-toggle');
await assertOnly('library');
check('abrir la biblioteca con raton cierra ajustes');

await page.keyboard.press('Escape');
await assertNone();
assert.equal(await activeId(), 'media-library-toggle', 'Escape debe devolver el foco al toggle de la biblioteca');
check('Escape cierra la biblioteca y devuelve el foco a su toggle');

await page.click('#ai-toggle');
await assertOnly('ai');
await page.click('#media-library-toggle');
await assertOnly('library');
check('abrir la biblioteca cierra el panel del asistente');
await page.keyboard.press('Escape');
await assertNone();

await page.focus('#communities-toggle');
await page.keyboard.press('Enter');
await assertOnly('communities');
check('comunidades se abre con teclado');
await page.focus('#media-library-toggle');
await page.keyboard.press('Enter');
await assertOnly('library');
check('la biblioteca abre por teclado y cierra comunidades (onOpen sin pointerdown)');
assert.ok(await page.evaluate(() => Boolean(document.querySelector('.media-library-modal')?.contains(document.activeElement))),
  'el foco debe quedar dentro del dialogo abierto');
check('el foco queda dentro del dialogo abierto');
await page.keyboard.press('Escape');
await assertNone();
assert.equal(await activeId(), 'media-library-toggle');
check('Escape con apertura por teclado devuelve el foco al toggle');

await page.focus('#media-library-toggle');
await page.keyboard.press('Enter');
await assertOnly('library');
await page.focus('#communities-toggle');
await page.keyboard.press('Enter');
await assertOnly('communities');
check('abrir comunidades por teclado cierra la biblioteca (exclusion inversa)');
await page.keyboard.press('Escape');
await assertNone();

await page.focus('#media-library-toggle');
await page.keyboard.press('Enter');
await assertOnly('library');
await page.focus('.rail-settings summary');
await page.keyboard.press('Enter');
await assertOnly('settings');
check('abrir ajustes por teclado cierra la biblioteca');

await page.click('#profile-toggle');
await assertOnly('profile');
check('abrir el perfil cierra ajustes');
await page.focus('#media-library-toggle');
await page.keyboard.press('Enter');
await assertOnly('library');
check('la biblioteca abre por teclado y cierra el perfil');
await page.keyboard.press('Escape');
await assertNone();

await page.focus('#media-library-toggle');
await page.keyboard.press('Enter');
await assertOnly('library');
await page.click('.rail-settings summary');
await page.click('#profile-toggle');
await assertOnly('profile');
check('el perfil por ruta mixta deja un unico panel abierto');
await page.keyboard.press('Escape');
await assertNone();

// Modales de features: comparten viewport con el rail y no pueden apilarse.
await page.click('.chat-item');
await page.waitForFunction(() => document.querySelector('.chat-item[aria-current=\"true\"]'), null, { timeout: 5000 });
await page.focus('#feature-chat-search');
await page.keyboard.press('Enter');
await page.waitForSelector('.feature-modal', { timeout: 5000 });
assert.deepEqual(await openPanels(), [], 'el modal de busqueda no debe abrir ningun panel del rail');
check('el modal de busqueda se abre sin paneles del rail');
await page.focus('#media-library-toggle');
await page.keyboard.press('Enter');
await assertOnly('library');
assert.equal(await page.evaluate(() => Boolean(document.querySelector('.feature-modal'))), false,
  'abrir la biblioteca debe cerrar el modal de features');
check('abrir la biblioteca cierra el modal de features (closePanels)');

const blockingWithLibrary = await page.evaluate(async () => (await import('/features-ui.mjs')).hasOpenBlockingDialog(document));
assert.equal(blockingWithLibrary, true, 'la biblioteca abierta debe contar como dialogo bloqueante');
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Control+Shift+f');
await page.waitForTimeout(150);
assert.equal(await page.evaluate(() => Boolean(document.querySelector('.feature-modal'))), false,
  'el atajo de busqueda no debe apilar un modal sobre la biblioteca');
assert.notEqual(await activeId(), 'search', 'el atajo debe quedar inerte con un dialogo abierto');
check('con la biblioteca abierta los atajos de features quedan inertes');
await page.keyboard.press('Escape');
await assertNone();
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Control+Shift+f');
assert.equal(await activeId(), 'search', 'sin dialogos abiertos el atajo de busqueda sigue vivo');
check('sin dialogos abiertos el atajo de busqueda sigue vivo');
await page.evaluate(() => document.activeElement?.blur());

// Drawer de contactos y modales de features: tambien con teclado y en los dos sentidos.
const directoryOpen = async () => Boolean(await page.$('.contact-directory-panel'));
await page.focus('#feature-chat-search');
await page.keyboard.press('Enter');
await page.waitForSelector('.feature-modal', { timeout: 5000 });
assert.deepEqual(await openPanels(), [], 'el modal abierto por teclado no debe dejar un panel del rail abierto');
check('abrir un modal de features por teclado cierra la biblioteca (onOpen de features)');
await page.keyboard.press('Escape');
await page.waitForSelector('.feature-modal', { state: 'detached', timeout: 5000 });

await page.focus('#media-library-toggle');
await page.keyboard.press('Enter');
await assertOnly('library');
await page.focus('#feature-new-chat');
await page.keyboard.press('Enter');
await page.waitForSelector('.contact-directory-panel', { timeout: 5000 });
assert.deepEqual(await openPanels(), [], 'el drawer abierto por teclado debe cerrar la biblioteca');
assert.equal(await directoryOpen(), true);
check('abrir el drawer de contactos por teclado cierra la biblioteca');
assert.ok(await page.evaluate(() => document.activeElement?.id === 'contact-directory-query'),
  'el foco debe quedar en el buscador del drawer');
check('el foco queda en el buscador del drawer abierto por teclado');
await page.keyboard.press('Escape');
await page.waitForSelector('.contact-directory-panel', { state: 'detached', timeout: 5000 });
await assertNone();
assert.equal(await activeId(), 'feature-new-chat', 'Escape debe devolver el foco al boton que abrio el drawer');
check('Escape cierra el drawer y devuelve el foco a su boton');

await page.focus('#feature-new-chat');
await page.keyboard.press('Enter');
await page.waitForSelector('.contact-directory-panel', { timeout: 5000 });
await page.focus('#media-library-toggle');
await page.keyboard.press('Enter');
await assertOnly('library');
assert.equal(await directoryOpen(), false, 'abrir la biblioteca debe cerrar el drawer de contactos');
check('abrir la biblioteca por teclado cierra el drawer de contactos');
await page.keyboard.press('Escape');
await assertNone();

await page.focus('#feature-new-chat');
await page.keyboard.press('Enter');
await page.waitForSelector('.contact-directory-panel', { timeout: 5000 });
await page.focus('#feature-chat-search');
await page.keyboard.press('Enter');
await page.waitForSelector('.feature-modal', { timeout: 5000 });
assert.equal(await directoryOpen(), false, 'el modal de features debe cerrar el drawer');
check('abrir un modal de features cierra el drawer de contactos');
await page.keyboard.press('Escape');
await assertNone();

// Escape cierra una sola capa: primero la vista previa y despues la biblioteca.
await page.click('#media-library-toggle');
await page.waitForSelector('.media-library-tile', { timeout: 5000 });
await page.click('.media-library-tile');
await page.waitForSelector('.media-library-preview:not([hidden])', { timeout: 5000 });
assert.equal(await openPanels().then(panels => panels.length), 1, 'la vista previa no cuenta como panel del rail');
await page.keyboard.press('Escape');
assert.equal(await page.evaluate(() => Boolean(document.querySelector('.media-library-preview:not([hidden])'))), false,
  'Escape debe cerrar primero la vista previa');
await assertOnly('library');
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Cerrar contenido multimedia',
  'tras cerrar la vista previa el foco sigue dentro del dialogo');
check('Escape cierra solo la vista previa y mantiene la biblioteca abierta');
await page.keyboard.press('Escape');
await assertNone();
assert.equal(await activeId(), 'media-library-toggle');
check('un segundo Escape cierra la biblioteca');

assert.deepEqual(unexpected, [], `rutas de API no previstas: ${unexpected.join(', ')}`);
check('todas las llamadas de API estan previstas en el fixture');
assert.deepEqual(pageErrors, [], `errores de pagina: ${pageErrors.join(' | ')}`);
check('sin errores de javascript en la pagina');

await browser.close();
server.close();
console.log(JSON.stringify({ status: 'passed', checks }));
