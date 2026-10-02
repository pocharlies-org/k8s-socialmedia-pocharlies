import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium, webkit, devices} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const root = fileURLToPath(new URL('../public/', import.meta.url));
const types = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2'};
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (file.includes('..')) throw Error('Invalid path');
    const body = await readFile(join(root, file));
    response.writeHead(200, {'content-type': types[extname(file)] || 'application/octet-stream'}).end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browserType = process.env.MOBILE_BROWSER === 'webkit' ? webkit : chromium;
const browser = await browserType.launch({headless: true, ...(browserType === chromium ? {args: ['--no-sandbox']} : {}), ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  const context = await browser.newContext(devices['iPhone 13']);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (route.request().headers().accept?.includes('text/event-stream')) return route.fulfill({status: 200, contentType: 'text/event-stream', body: ': fixture heartbeat\n\n'});
    if (url.pathname.startsWith('/api/media/')) return route.fulfill({status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64')});
    const account = url.searchParams.get('account') || 'personal';
    const data = url.pathname === '/api/accounts'
      ? {accounts: [{id: 'personal', label: 'Personal'}, {id: 'secondary', label: 'Secundaria'}], sendingEnabled: true}
      : url.pathname === '/api/chats'
        ? {chats: [{id: `${account}-chat`, name: account === 'personal' ? 'Ana' : 'Bruno', preview: 'Hola', unread: 0, pinned: true}]}
        : url.pathname === '/api/novedades/status/authors' ? {account, authors: []}
        : url.pathname === '/api/messages' ? {messages: [{id: 'one', text: 'Hola', timestamp: '2026-09-28T10:00:00Z'}, {id: 'two', text: `https://example.com/${'unbroken'.repeat(90)}`, timestamp: '2026-09-28T10:01:00Z'}, {id: 'image-current', type: 'IMAGE', timestamp: '2026-09-28T10:02:00Z', attachments: [{id: 'attachment-current', name: 'current.png', mimeType: 'image/png', url: `/api/media/attachment-current?account=${account}&chat=${account}-chat`}]}]}
          : url.pathname === '/api/chats/media' ? {account, chat: url.searchParams.get('chat'), items: url.searchParams.get('cursor')
            ? [{id: 'attachment-older', url: `/api/media/attachment-older?account=${account}&chat=${account}-chat`, name: 'older.png'}]
            : [{id: 'attachment-current', url: `/api/media/attachment-current?account=${account}&chat=${account}-chat`, name: 'current.png'}], nextCursor: url.searchParams.get('cursor') ? null : 'older'}
          : url.pathname === '/api/models' ? {models: [{id: 'fixture'}], defaultModel: 'fixture'}
            : url.pathname === '/api/ai/session' ? {sessionId: 'fixture', messages: []}
              : {proposals: []};
    return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(data)});
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.waitForFunction(() => document.querySelectorAll('#account option').length === 2 && document.querySelectorAll('#chats .chat-item').length === 1);

  const manifest = await page.locator('link[rel="manifest"]').getAttribute('href');
  const metadata = await page.evaluate(() => ({
    viewport: document.querySelector('meta[name="viewport"]')?.content,
    capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
    touchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
  }));
  assert(metadata.viewport.includes('width=device-width') && metadata.viewport.includes('viewport-fit=cover'));
  assert(metadata.viewport.includes('user-scalable=no') && metadata.viewport.includes('maximum-scale=1'));
  assert.equal(metadata.capable, 'yes');
  assert(metadata.touchIcon);
  const manifestResponse = await page.request.get(new URL(manifest, url).href);
  const config = await manifestResponse.json();
  assert.equal(config.display, 'standalone');
  assert.equal(config.start_url, '/');
  assert.equal(config.scope, '/');
  for (const size of ['192x192', '512x512']) {
    const icon = config.icons.find(entry => entry.sizes === size && entry.type === 'image/png');
    assert(icon, `Missing ${size} PNG icon`);
    const response = await page.request.get(new URL(icon.src, url).href);
    assert.equal(response.status(), 200);
    assert.equal((await response.body()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  assert.equal((await page.request.get(new URL(metadata.touchIcon, url).href)).status(), 200);

  async function geometry(label) {
    const state = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
      const rail = rect('.app-rail');
      const sidebar = rect('.chat-sidebar');
      const conversation = rect('.conversation');
      const composer = rect('.composer');
      const shell = rect('.app-shell');
      return {width: innerWidth, height: innerHeight, shell: {top: shell.top, bottom: shell.bottom}, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, rail: rail && {x: rail.x, y: rail.y, width: rail.width, height: rail.height}, sidebar: sidebar && {x: sidebar.x, width: sidebar.width}, conversation: conversation && {x: conversation.x, width: conversation.width}, composer: composer && {y: composer.y, bottom: composer.bottom}};
    });
    assert(state.documentWidth <= state.width + 1 && state.bodyWidth <= state.width + 1, `${label}: horizontal overflow ${JSON.stringify(state)}`);
    assert(Math.abs(state.shell.top) <= 1 && Math.abs(state.shell.bottom - state.height) <= 1, `${label}: app does not fill the viewport ${JSON.stringify(state)}`);
    const chatOpen = await page.evaluate(() => document.body.classList.contains('chat-open'));
    const bottom = chatOpen ? state.composer.bottom : state.rail.y + state.rail.height;
    assert(Math.abs(bottom - state.height) <= 1, `${label}: unused space below bottom controls ${JSON.stringify(state)}`);
    return state;
  }
  let state = await geometry('chat list');
  assert.equal(await page.locator('.app-shell').evaluate(element => getComputedStyle(element).touchAction), 'pan-x pan-y');
  const gestureBlocked = await page.locator('.app-shell').evaluate(element => {
    const modal = document.createElement('div');
    modal.className = 'feature-modal';
    const viewer = document.createElement('div');
    viewer.className = 'media-viewer';
    document.body.append(modal, viewer);
    const gesture = new Event('gesturestart', {bubbles: true, cancelable: true});
    element.dispatchEvent(gesture);
    const touch = new Event('touchmove', {bubbles: true, cancelable: true});
    Object.defineProperty(touch, 'touches', {value: [{}, {}]});
    element.dispatchEvent(touch);
    const singleTouch = new Event('touchmove', {bubbles: true, cancelable: true});
    Object.defineProperty(singleTouch, 'touches', {value: [{}]});
    element.dispatchEvent(singleTouch);
    const dialogGesture = new Event('gesturestart', {bubbles: true, cancelable: true});
    modal.dispatchEvent(dialogGesture);
    const viewerGesture = new Event('gesturestart', {bubbles: true, cancelable: true});
    viewer.dispatchEvent(viewerGesture);
    modal.remove();
    viewer.remove();
    return {gesture: gesture.defaultPrevented, touch: touch.defaultPrevented, singleTouch: singleTouch.defaultPrevented, dialogGesture: dialogGesture.defaultPrevented, viewerGesture: viewerGesture.defaultPrevented};
  });
  assert.deepEqual(gestureBlocked, {gesture: true, touch: true, singleTouch: false, dialogGesture: true, viewerGesture: false});
  assert(state.rail.y > 400 && state.sidebar.width >= state.width - 1, `Expected full-width list and bottom account navigation: ${JSON.stringify(state)}`);
  assert(state.rail.y + state.rail.height <= state.height + 1, `Bottom navigation is clipped: ${JSON.stringify(state)}`);
  assert.equal(await page.locator('#account-rail button').count(), 2);
  assert.equal(await page.locator('#chats .chat-pin[aria-label="Chat fijado"]').count(), 1);
  const searchFont = await page.locator('#search').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  assert(searchFont >= 16, `Search text too small for iOS focus: ${searchFont}px`);
  if (process.env.UI_SCREENSHOT_PATH) await page.screenshot({path: `${process.env.UI_SCREENSHOT_PATH}-list.png`});
  await page.getByRole('button', {name: 'Cuenta de WhatsApp: Secundaria'}).tap();
  await page.waitForFunction(() => document.querySelector('#chats')?.textContent.includes('Bruno'));
  await page.locator('#chats .chat-item').first().tap();
  await page.waitForFunction(() => document.body.classList.contains('chat-open'));
  state = await geometry('conversation');
  assert(state.conversation.width >= state.width - 1, `Expected full-width conversation: ${JSON.stringify(state)}`);
  assert.equal(await page.evaluate(() => history.state?.socialMediaChat), true);
  await page.goBack();
  await page.waitForFunction(() => !document.body.classList.contains('chat-open'));
  await page.goForward();
  await page.waitForFunction(() => document.body.classList.contains('chat-open'));
  assert.equal(await page.locator('#chat-title').textContent(), 'Bruno');
  await page.locator('#messages .media-image-button').tap();
  await page.getByText('1 / 1+', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Imagen anterior', exact: true}).tap();
  await page.locator('.media-viewer-image[alt="older.png"]').waitFor();
  assert.equal(await page.locator('.media-viewer-image').getAttribute('alt'), 'older.png');
  await page.getByRole('button', {name: 'Cerrar imagen'}).tap();
  if (process.env.UI_SCREENSHOT_PATH) await page.screenshot({path: `${process.env.UI_SCREENSHOT_PATH}-chat.png`});
  const composerFont = await page.locator('#message').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  assert(composerFont >= 16, `Composer text too small for iOS focus: ${composerFont}px`);
  await page.locator('#message').focus();
  await page.getByRole('button', {name: 'Abrir Social Media Agent'}).tap();
  assert(await page.locator('#ai-panel').isVisible());
  await geometry('agent panel');
  const agentFont = await page.locator('.ai-composer textarea').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  assert(agentFont >= 16, `Agent text too small for iOS focus: ${agentFont}px`);
  await page.getByRole('button', {name: 'Cerrar Social Media Agent'}).tap();
  await page.getByRole('button', {name: 'Volver a los chats'}).tap();
  await page.waitForFunction(() => !document.body.classList.contains('chat-open'));
  assert.equal(await page.evaluate(() => history.state?.socialMediaChat), undefined);
  await geometry('back to list');
  await page.locator('.rail-settings summary').tap();
  assert(await page.locator('#settings-panel').isVisible());
  const selectFont = await page.locator('#account').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  assert(selectFont >= 16, `Settings select too small for iOS focus: ${selectFont}px`);
  await geometry('settings');
  await page.getByRole('button', {name: 'Cerrar ajustes'}).tap();
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({width, height: 700});
    const narrow = await geometry(`${width}px chat list`);
    assert(narrow.sidebar.width >= width - 1 && narrow.rail.y + narrow.rail.height <= narrow.height + 1, `${width}px mobile layout is clipped: ${JSON.stringify(narrow)}`);
    await page.locator('#chats .chat-item').first().tap();
    const opened = await geometry(`${width}px conversation`);
    assert(opened.conversation.width >= width - 1, `${width}px conversation is clipped: ${JSON.stringify(opened)}`);
    await page.getByRole('button', {name: 'Volver a los chats'}).tap();
  }
  await page.setViewportSize({width: 320, height: 420});
  await page.locator('#chats .chat-item').first().tap();
  const shortScreen = await geometry('short mobile viewport with long URL');
  assert(shortScreen.composer.bottom <= shortScreen.height + 1, `Composer is clipped: ${JSON.stringify(shortScreen)}`);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#chats .chat-item').length === 1);
  assert.equal(await page.evaluate(() => history.state?.socialMediaChat), false, 'reload must clear a stale chat history entry');
  await page.locator('#chats .chat-item').first().tap();
  await page.goBack();
  await page.waitForFunction(() => !document.body.classList.contains('chat-open'));
  assert.deepEqual(errors, []);
  await context.close();
  console.log(`PASS mobile PWA (${browserType.name()}): manifest/icons, iPhone touch and history navigation, accounts, historical image viewer, agent, input sizing and overflow`);
} finally {
  await browser.close();
  server.close();
}
