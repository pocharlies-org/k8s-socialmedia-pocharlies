import assert from 'node:assert/strict';
import { startPublicFixture, sidebarMenuFixture } from './browser-fixture.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
function initializeSidebar(installFeatureUI) {
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
}
const fixture = sidebarMenuFixture(initializeSidebar);
const server = await startPublicFixture({ html: fixture });
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
