#!/usr/bin/env node
// Synthetic browser QA: all API responses are local fixtures; no live account is touched.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const source = path.resolve(process.env.UI_SOURCE_DIR || new URL('../public', import.meta.url).pathname);
const output = path.resolve(process.env.UI_OUTPUT_DIR || '/tmp/socialmedia-parity-panels-20260927');
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome';
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const accounts = [{ id: 'alpha', label: 'Cuenta Alpha' }, { id: 'beta', label: 'Cuenta Beta' }];
const communities = {
  alpha: [{ id: 'alpha-community', name: 'Comunidad Alpha', participantCount: 12, capabilities: { editInfo: true, manageGroups: true, leave: true } }],
  beta: [{ id: 'beta-community', name: 'Comunidad Beta', participantCount: 6, capabilities: { editInfo: false, manageGroups: false, leave: true } }],
};
const state = { requests: [], delayedAlpha: null };

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(source, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (file !== source && !file.startsWith(`${source}${path.sep}`)) { res.writeHead(403); res.end(); return; }
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': contentTypes[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const errors = [];

async function mock(route) {
  const request = route.request();
  const url = new URL(request.url());
  const account = url.searchParams.get('account') || 'alpha';
  const pathname = url.pathname;
  const body = request.postData();
  state.requests.push({ pathname, account, method: request.method(), body, headers: request.headers() });
  const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  if (pathname === '/auth/logout') return route.fulfill({ status: 204, body: '' });
  if (pathname === '/api/accounts') return json({ accounts, sendingEnabled: true, outboxScope: 'fixture' });
  if (pathname === '/api/chats') return json({ account, chats: [{ id: `${account}-chat`, account, name: `Chat ${account}`, preview: 'Mensaje fixture', isGroup: false, unread: 0 }] });
  if (pathname === '/api/messages') return json({ account, messages: [] });
  if (pathname === '/api/notifications') return json({ account, permission: 'unknown', enabled: false, unread: 0 });
  if (pathname === '/api/favorites') return json({ account, favorites: [], lists: [], starred: [] });
  if (pathname === '/api/lists') return json({ account, lists: [] });
  if (pathname === '/api/privacy') return json({ account, profile: 'all', lastSeen: 'all', readReceipts: true });
  if (pathname === '/api/communities') {
    if (account === 'alpha' && state.delayedAlpha) {
      state.delayedAlpha.started();
      await state.delayedAlpha.promise;
    }
    return json({ account, communities: communities[account] });
  }
  const detail = /^\/api\/communities\/([^/]+)$/.exec(pathname);
  if (detail) {
    const community = communities[account].find(item => item.id === detail[1]);
    return json({ account, community, linkedGroups: [{ id: '120363000000010@g.us', chatId: `${account}-archived-group`, name: 'Grupo de la comunidad', participantCount: 8 }] });
  }
  if (pathname === '/api/send') return json({ account, confirmed: true, messageId: 'fixture-send' });
  return json({ account, items: [], chats: [], messages: [], confirmed: true });
}

async function pageFor(viewport, theme) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', mock);
  await page.route('**/auth/logout', mock);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#account option').length === 2);
  await page.locator('#chats .chat-item').first().waitFor();
  return { page, context };
}

async function openSettings(page) {
  await page.locator('.rail-settings summary').click();
  await page.locator('#settings-panel').waitFor({ state: 'visible' });
}

try {
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const { page, context } = await pageFor(viewport, 'dark');
    await openSettings(page);
    for (const theme of ['dark', 'light']) {
      await page.locator('#theme').selectOption(theme);
      assert.equal(await page.locator('body').getAttribute('data-theme'), theme);
      await page.screenshot({ path: path.join(output, `settings-${name}-${theme}.png`), fullPage: true });
    }
    const panel = await page.locator('#settings-panel').boundingBox();
    assert(panel && panel.x >= 0 && panel.x + panel.width <= viewport.width + 1, `${name}: settings panel is clipped`);
    const header = await page.locator('.settings-header').boundingBox();
    const accountSection = await page.locator('.settings-section').first().boundingBox();
    assert(header && accountSection && header.y < accountSection.y, `${name}: settings sections are not stacked`);
    assert(header.width >= panel.width - 2 && accountSection.width >= panel.width - 2, `${name}: settings sections do not fill the panel`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: horizontal page overflow`);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.rail-settings').evaluate(element => element.open), false);
    if (name === 'desktop') {
      await openSettings(page);
      await page.mouse.click(viewport.width - 8, 10);
      assert.equal(await page.locator('.rail-settings').evaluate(element => element.open), false);
    }
    await context.close();
  }

  const { page, context } = await pageFor({ width: 1440, height: 900 }, 'dark');
  await page.locator('#chats .chat-item').first().click();
  await openSettings(page);
  await page.locator('#settings-spellcheck').uncheck();
  assert.equal(await page.locator('#message').evaluate(element => element.spellcheck), false);
  await page.locator('#settings-enter-send').uncheck();
  assert.equal(await page.evaluate(() => localStorage.getItem('wa-enter-to-send')), 'false');
  await page.locator('input[name="wallpaper"][value="sage"]').check();
  assert.equal(await page.locator('body').getAttribute('data-wallpaper'), 'sage');
  await page.locator('#settings-close').click();
  await page.locator('#message').fill(':');
  await page.keyboard.insertText(')');
  assert.equal(await page.locator('#message').inputValue(), '🙂');
  await openSettings(page);
  await page.locator('#settings-emoji-replacement').uncheck();
  await page.locator('#settings-close').click();
  await page.locator('#message').fill(':');
  await page.keyboard.insertText(')');
  assert.equal(await page.locator('#message').inputValue(), ':)');
  await page.locator('#message').fill('Linea');
  await page.locator('#message').press('Enter');
  assert.equal(await page.locator('#message').inputValue(), 'Linea\n');
  await page.locator('#message').press('Control+Enter');
  assert(state.requests.some(request => request.pathname === '/api/send'), 'Ctrl+Enter did not send');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#account option').length === 2);
  await openSettings(page);
  assert.equal(await page.locator('#settings-spellcheck').isChecked(), false);
  assert.equal(await page.locator('#settings-emoji-replacement').isChecked(), false);
  assert.equal(await page.locator('#settings-enter-send').isChecked(), false);
  assert.equal(await page.locator('input[name="wallpaper"][value="sage"]').isChecked(), true);
  await page.locator('#settings-logout').click();
  const logout = state.requests.find(request => request.pathname === '/auth/logout');
  assert(logout && logout.method === 'POST' && logout.headers['content-type'].includes('application/json'), 'logout request contract failed');
  await context.close();

  const communityPage = await pageFor({ width: 1440, height: 900 }, 'dark');
  await communityPage.page.locator('#communities-toggle').click();
  await communityPage.page.locator('[data-community-id="alpha-community"]').first().waitFor();
  await communityPage.page.locator('[data-community-id="alpha-community"]').first().click();
  await communityPage.page.getByRole('button', { name: 'Editar nombre' }).waitFor();
  await communityPage.page.screenshot({ path: path.join(output, 'communities-desktop-dark.png') });
  await communityPage.page.setViewportSize({ width: 390, height: 844 });
  await communityPage.page.screenshot({ path: path.join(output, 'communities-mobile-dark.png') });
  await communityPage.page.setViewportSize({ width: 1440, height: 900 });
  await communityPage.page.locator('.communities-group-open').click();
  assert.equal(await communityPage.page.locator('#chat-title').textContent(), 'Grupo de la comunidad');
  await openSettings(communityPage.page);
  await communityPage.page.locator('#account').selectOption('beta');
  assert.equal(await communityPage.page.locator('#settings-close').isVisible(), false, 'account switch closes settings');
  await communityPage.page.locator('#communities-toggle').click();
  await communityPage.page.locator('[data-community-id="beta-community"]').first().waitFor();
  await communityPage.page.locator('[data-community-id="beta-community"]').first().click();
  assert.equal(await communityPage.page.getByRole('button', { name: 'Editar nombre' }).count(), 0, 'non-admin sees edit action');
  await communityPage.context.close();

  let startAlpha;
  let releaseAlpha;
  const alphaStarted = new Promise(resolve => { startAlpha = resolve; });
  const alphaRelease = new Promise(resolve => { releaseAlpha = resolve; });
  state.delayedAlpha = { started: startAlpha, promise: alphaRelease };
  const racePage = await pageFor({ width: 1440, height: 900 }, 'dark');
  await racePage.page.locator('#communities-toggle').click();
  await alphaStarted;
  await racePage.page.evaluate(() => {
    const account = document.getElementById('account');
    account.value = 'beta';
    account.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await racePage.page.waitForFunction(() => document.querySelector('#chats')?.textContent.includes('Chat beta'));
  await racePage.page.locator('#communities-toggle').click();
  await racePage.page.locator('[data-community-id="beta-community"]').first().waitFor();
  releaseAlpha();
  await racePage.page.waitForTimeout(100);
  assert.equal(await racePage.page.locator('[data-community-id="alpha-community"]').count(), 0, 'stale alpha community leaked into beta');
  await racePage.context.close();
  state.delayedAlpha = null;

  await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', screenshots: ['settings-desktop-dark.png', 'settings-desktop-light.png', 'settings-mobile-dark.png', 'settings-mobile-light.png'], requests: state.requests.length, pageErrors: errors }, null, 2));
  assert.deepEqual(errors, [], 'browser page errors');
  console.log(`PASS parity panels; screenshots and result in ${output}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
