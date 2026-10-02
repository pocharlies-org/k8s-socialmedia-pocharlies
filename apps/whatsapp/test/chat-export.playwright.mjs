import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const filename = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!filename.startsWith(`${publicDir}${path.sep}`)) return response.writeHead(403).end();
  try {
    const body = await readFile(filename);
    response.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(filename)] || 'application/octet-stream' }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome' });
const page = await browser.newPage();
const errors = [];
const downloads = [];
const scopes = [];
let mode = 'ok';
let releasePage;
page.on('pageerror', error => errors.push(error.message));
page.on('download', download => downloads.push(download));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (url.pathname === '/api/accounts') return json({ accounts: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }], sendingEnabled: false });
  if (url.pathname === '/api/chats') return json({ chats: [{ id: 'one', name: 'Uno' }] });
  if (url.pathname === '/api/messages') {
    if (url.searchParams.has('before')) {
      scopes.push([url.searchParams.get('account'), url.searchParams.get('chat'), url.searchParams.get('before')]);
      if (mode === 'fail') return json({ error: { message: 'Fallo de pagina sintetico' } }, 503);
      if (mode === 'delay') await new Promise(resolve => { releasePage = resolve; });
      return json({ messages: [{ id: 'old', text: 'Texto antiguo', timestamp: '2026-09-20T10:00:00Z', fromMe: false, senderName: 'Uno' }], nextCursor: null });
    }
    return json({ messages: [{ id: 'new', text: 'Texto nuevo', timestamp: '2026-09-21T10:00:00Z', fromMe: true }], nextCursor: 'older-page' });
  }
  return json({ models: [], items: [], communities: [], lists: [], favorites: [], sessions: [] });
});
async function openExport() {
  await page.getByRole('button', { name: 'Opciones de chat', exact: true }).click();
  await page.getByRole('button', { name: 'Exportar chat', exact: true }).click();
  await page.getByRole('button', { name: 'Exportar TXT', exact: true }).click();
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#chats .chat-item').first().click();
  const downloaded = page.waitForEvent('download');
  await openExport();
  const download = await downloaded;
  const transcript = await readFile(await download.path(), 'utf8');
  assert(transcript.indexOf('Texto antiguo') < transcript.indexOf('Texto nuevo'));
  assert.match(download.suggestedFilename(), /^whatsapp-alpha-one-.*\.txt$/);
  assert.deepEqual(scopes[0], ['alpha', 'one', 'older-page']);
  await page.keyboard.press('Escape');
  mode = 'fail';
  await openExport();
  await page.getByText(/Error al leer mensajes/).waitFor();
  assert.equal(downloads.length, 1);
  await page.keyboard.press('Escape');
  mode = 'delay';
  await openExport();
  while (!releasePage) await new Promise(resolve => setTimeout(resolve, 10));
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.getByRole('button', { name: 'Cuenta de WhatsApp: Beta', exact: true }).click();
  releasePage();
  await page.waitForTimeout(250);
  assert.equal(downloads.length, 1);
  await page.locator('#chats .chat-item').first().click();
  releasePage = null;
  await openExport();
  while (!releasePage) await new Promise(resolve => setTimeout(resolve, 10));
  await page.locator('#account').evaluate(select => { select.value = 'alpha'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  releasePage();
  await page.waitForTimeout(250);
  assert.equal(await page.getByRole('button', { name: 'Exportar TXT', exact: true }).count(), 0);
  assert.equal(downloads.length, 1);
  await page.locator('#chats .chat-item').first().click();
  if (process.env.UI_OUTPUT_DIR) await mkdir(process.env.UI_OUTPUT_DIR, { recursive: true });
  for (const [width, theme] of [[390, 'light'], [1280, 'dark']]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(theme => { document.body.dataset.theme = theme; }, theme);
    await page.getByRole('button', { name: 'Opciones de chat', exact: true }).click();
    const bounds = await page.locator('.feature-modal-menu .feature-dialog').boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 844);
    await page.getByRole('button', { name: 'Exportar chat', exact: true }).click();
    const dialog = await page.locator('.feature-dialog').boundingBox();
    assert(dialog && dialog.x >= 0 && dialog.x + dialog.width <= width);
    if (process.env.UI_OUTPUT_DIR) await page.screenshot({ path: path.join(process.env.UI_OUTPUT_DIR, `export-${width}-${theme}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', syntheticDownloads: downloads.length, canceled: true, partialDownload: false }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
