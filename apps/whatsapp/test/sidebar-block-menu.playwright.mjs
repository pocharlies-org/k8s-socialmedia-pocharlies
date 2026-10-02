import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const root = fileURLToPath(new URL('../public/', import.meta.url));
const fixture = `<!doctype html><button id="opener">Opciones</button><script type="module">
import { installFeatureUI } from '/features-ui.mjs';
window.calls = [];
window.blockState = false;
window.target = { id: 'target@lid', name: 'Contacto', isGroup: false };
window.ui = installFeatureUI({
  state: { account: 'alpha', chat: 'other@lid' },
  api: async (path, body) => {
    calls.push({ path, body });
    if (path.startsWith('/api/contact-block')) return blockState === null ? { confirmed: false } : { confirmed: true, blocked: blockState };
    if (path === '/api/chat-actions') return { confirmed: true, blocked: body.action === 'block' };
    return {};
  },
  query: (path, values) => path + '?' + new URLSearchParams(values),
  getChats: () => [target],
});
document.querySelector('#opener').onclick = () => ui.openSidebarChatMenu(target, document.querySelector('#opener'));
</script>`;
const server = createServer(async (req, res) => {
  try {
    res.setHeader('Content-Type', req.url === '/' ? 'text/html' : 'text/javascript');
    res.end(req.url === '/' ? fixture : await readFile(root + req.url.slice(1)));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.ui);

  await page.locator('#opener').click();
  await page.getByRole('menuitem', { name: 'Bloquear', exact: true }).waitFor();
  assert((await page.evaluate(() => calls)).some(call => call.path.includes('account=alpha') && call.path.includes('chat=target%40lid')));
  await page.getByRole('menuitem', { name: 'Bloquear', exact: true }).click();
  assert.equal(await page.evaluate(() => calls.filter(call => call.path === '/api/chat-actions').length), 0);
  await page.getByRole('button', { name: 'Bloquear', exact: true }).click();
  assert.deepEqual((await page.evaluate(() => calls.filter(call => call.path === '/api/chat-actions'))).at(-1)?.body,
    { account: 'alpha', chat: 'target@lid', action: 'block' });

  await page.evaluate(() => window.blockState = true);
  await page.locator('#opener').click();
  await page.getByRole('menuitem', { name: 'Desbloquear', exact: true }).click();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal(await page.evaluate(() => calls.filter(call => call.path === '/api/chat-actions').length), 1);

  await page.evaluate(() => window.blockState = null);
  await page.locator('#opener').click();
  await page.waitForTimeout(50);
  assert.equal(await page.getByRole('menuitem', { name: /Bloquear|Desbloquear/ }).count(), 0);
  console.log('PASS sidebar block: provider state, confirmation, account/chat isolation and unavailable state');
} finally {
  await browser.close();
  server.close();
}
