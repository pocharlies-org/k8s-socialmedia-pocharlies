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
  await page.addInitScript(() => {
    const viewport = window.visualViewport;
    let simulated = null;
    const nativeHeight = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewport), 'height').get;
    const nativeTop = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewport), 'offsetTop').get;
    Object.defineProperties(viewport, {
      height: {get: () => simulated?.height ?? nativeHeight.call(viewport)},
      offsetTop: {get: () => simulated?.top ?? nativeTop.call(viewport)},
    });
    window.setKeyboardViewport = (value, notify = true) => {
      simulated = value;
      if (notify) viewport.dispatchEvent(new Event('resize'));
    };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixtureRoute = route => {
    const url = new URL(route.request().url());
    if (route.request().headers().accept?.includes('text/event-stream')) return route.fulfill({status: 200, contentType: 'text/event-stream', body: ': fixture heartbeat\n\n'});
    if (url.pathname.startsWith('/api/media/')) return route.fulfill({status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64')});
    const account = url.searchParams.get('account') || 'personal';
    const data = url.pathname === '/api/accounts'
      ? {accounts: [{id: 'personal', label: 'Personal'}, {id: 'secondary', label: 'Secundaria'}], sendingEnabled: true}
      : url.pathname === '/api/chats'
        ? {chats: [{id: `${account}-chat`, name: account === 'personal' ? 'Ana' : 'Bruno', preview: 'Hola', unread: 0, pinned: true, archived: url.searchParams.get('archived') === 'only'}]}
        : url.pathname === '/api/novedades/status/authors' ? {account, authors: []}
        : url.pathname === '/api/messages' ? {messages: [{id: 'one', text: 'Hola', timestamp: '2026-09-28T10:00:00Z'}, {id: 'two', text: `https://example.com/${'unbroken'.repeat(90)}`, timestamp: '2026-09-28T10:01:00Z'}, {id: 'image-current', type: 'IMAGE', timestamp: '2026-09-28T10:02:00Z', attachments: [{id: 'attachment-current', name: 'current.png', mimeType: 'image/png', url: `/api/media/attachment-current?account=${account}&chat=${account}-chat`}]}]}
          : url.pathname === '/api/chats/media' ? {account, chat: url.searchParams.get('chat'), items: url.searchParams.get('cursor')
            ? [{id: 'attachment-older', url: `/api/media/attachment-older?account=${account}&chat=${account}-chat`, name: 'older.png'}]
            : [{id: 'attachment-current', url: `/api/media/attachment-current?account=${account}&chat=${account}-chat`, name: 'current.png'}], nextCursor: url.searchParams.get('cursor') ? null : 'older'}
          : url.pathname === '/api/models' ? {models: [{id: 'fixture'}], defaultModel: 'fixture'}
            : url.pathname === '/api/ai/session' ? {sessionId: 'fixture', messages: []}
              : {proposals: []};
    return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(data)});
  };
  await page.route('**/api/**', fixtureRoute);
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.waitForFunction(() => document.querySelectorAll('#account option').length === 2 && document.querySelectorAll('#chats .chat-item').length === 1);
  // Headless engines do not expose an iPhone notch/home indicator. Exercise
  // the same safe-area inputs explicitly instead of silently testing zeroes.
  await page.addStyleTag({content: ':root { --mobile-safe-area-top: 59px; --mobile-safe-area-bottom: 34px; }'});

  async function usableControl(selector, label) {
    const result = await page.locator(selector).evaluate(element => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {top: rect.top, bottom: rect.bottom, hit: element === hit || element.contains(hit)};
    });
    assert(result.top >= 59 && result.bottom <= (await page.evaluate(() => innerHeight)) - 34 && result.hit, `${label}: control outside safe area or not hit-testable ${JSON.stringify(result)}`);
  }

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
    await page.waitForFunction(() => Math.abs(document.querySelector('.app-shell').getBoundingClientRect().bottom - innerHeight) <= 1);
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
  await page.locator('#feature-archived-entry').tap();
  await page.waitForFunction(() => document.querySelector('.chat-sidebar').dataset.archiveView === 'true');
  await usableControl('.feature-archive-back', 'archived back');
  await geometry('archived list');
  await page.locator('.feature-archive-back').tap();
  await page.waitForFunction(() => document.querySelector('.chat-sidebar').dataset.archiveView === 'false');
  const rootPan = await page.addStyleTag({content: 'html { height: calc(100dvh + 120px); }'});
  await page.evaluate(() => window.scrollTo(0, 60));
  await page.waitForFunction(() => scrollY === 0);
  await geometry('root pan recovery');
  await rootPan.evaluate(element => element.remove());
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
  // Native iOS keyboards cannot be opened in headless WebKit. Exercise their
  // viewport contract, including a late closing measurement without resize.
  const fullHeight = await page.evaluate(() => innerHeight);
  await page.evaluate(height => window.setKeyboardViewport({height: height - 300, top: 20}), fullHeight);
  await page.waitForFunction(height => Math.abs(document.querySelector('.composer').getBoundingClientRect().bottom - (height - 280)) <= 1, fullHeight);
  await page.locator('#message').evaluate(element => element.blur());
  await page.evaluate(() => window.setKeyboardViewport(null, false));
  await page.waitForFunction(height => Math.abs(document.querySelector('.composer').getBoundingClientRect().bottom - height) <= 1, fullHeight);
  await geometry('keyboard dismissed without final viewport event');
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.locator('#message').focus();
    await page.evaluate(height => window.setKeyboardViewport({height: height - 280, top: 0}), fullHeight);
    await page.waitForFunction(height => Math.abs(document.querySelector('.composer').getBoundingClientRect().bottom - (height - 280)) <= 1, fullHeight);
    // WebKit can leave a small phantom viewport offset after dismissing the
    // keyboard without blurring the input. It must not move app controls.
    await page.evaluate(height => window.setKeyboardViewport({height: height - 24, top: 24}), fullHeight);
    await page.waitForFunction(height => Math.abs(document.querySelector('.composer').getBoundingClientRect().bottom - height) <= 1, fullHeight);
    await geometry('keyboard dismissed while input keeps focus');
  }
  await page.locator('#message').evaluate(element => element.blur());
  await page.evaluate(() => window.setKeyboardViewport(null));
  const fullWidth = await page.evaluate(() => innerWidth);
  await page.setViewportSize({width: fullWidth, height: fullHeight - 100});
  await page.evaluate(height => {
    window.setKeyboardViewport({height: height - 124, top: 24}, false);
    window.dispatchEvent(new Event('pageshow'));
  }, fullHeight);
  await page.waitForFunction(height => Math.abs(document.querySelector('.composer').getBoundingClientRect().bottom - (height - 100)) <= 1, fullHeight);
  // Wait past the settlement callbacks through the page's own timer queue;
  // checking only the first frame would miss a later stale-height restoration.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1300)));
  assert(await page.evaluate(height => Math.abs(document.querySelector('.composer').getBoundingClientRect().bottom - (height - 100)) <= 1, fullHeight), 'returning to a smaller viewport must not restore an obsolete taller height');
  await page.evaluate(() => window.setKeyboardViewport(null));
  await page.setViewportSize({width: fullWidth, height: fullHeight});
  await geometry('return to normal viewport');
  await page.getByRole('button', {name: 'Abrir Social Media Agent'}).tap();
  assert(await page.locator('#ai-panel').isVisible());
  await geometry('agent panel');
  const agentFont = await page.locator('.ai-composer textarea').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  assert(agentFont >= 16, `Agent text too small for iOS focus: ${agentFont}px`);
  await usableControl('#ai-close', 'agent close');
  await page.getByRole('button', {name: 'Cerrar Social Media Agent'}).tap();
  for (const name of ['Buscar mensajes', 'Información del chat']) {
    await page.getByRole('button', {name, exact: true}).tap();
    await panelBounds('.feature-modal-panel .feature-dialog', name);
    await usableControl('.feature-dialog-close', `${name} close`);
    await page.getByRole('button', {name: 'Cerrar', exact: true}).tap();
  }
  await page.getByRole('button', {name: 'Volver a los chats'}).tap();
  await page.waitForFunction(() => !document.body.classList.contains('chat-open'));
  assert.equal(await page.evaluate(() => history.state?.socialMediaChat), undefined);
  await geometry('back to list');
  async function panelBounds(selector, label) {
    await page.waitForFunction(selector => {
      const r = document.querySelector(selector)?.getBoundingClientRect();
      return r && Math.abs(r.top) <= 1 && Math.abs(r.bottom - innerHeight) <= 1;
    }, selector);
    const bounds = await page.locator(selector).evaluate(element => {
      const r = element.getBoundingClientRect();
      return {top: r.top, bottom: r.bottom, height: innerHeight};
    });
    assert(Math.abs(bounds.top) <= 1 && Math.abs(bounds.bottom - bounds.height) <= 1, `${label}: panel uses a different viewport ${JSON.stringify(bounds)}`);
  }
  await page.getByRole('button', {name: 'Nuevo chat', exact: true}).tap();
  await panelBounds('.contact-directory-panel', 'new chat');
  await usableControl('.contact-directory-close', 'new chat close');
  await page.getByRole('button', {name: 'Cerrar Nuevo chat'}).tap();
  for (const entry of ['Estados', 'Canales']) {
    await page.getByRole('button', {name: entry, exact: true}).tap();
    await panelBounds('.novedades-panel', entry);
    await usableControl('.novedades-close', `${entry} close`);
    await page.getByRole('button', {name: 'Cerrar Novedades'}).tap();
  }
  await page.getByRole('button', {name: 'Contenido multimedia', exact: true}).tap();
  await panelBounds('.media-library-modal', 'media library');
  await usableControl('.media-library-header-top .media-library-close', 'media library close');
  await page.getByRole('button', {name: 'Cerrar contenido multimedia'}).tap();
  await page.locator('.rail-settings summary').tap();
  assert(await page.locator('#settings-panel').isVisible());
  const selectFont = await page.locator('#account').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  assert(selectFont >= 16, `Settings select too small for iOS focus: ${selectFont}px`);
  await geometry('settings');
  await panelBounds('#settings-panel', 'settings');
  await usableControl('#settings-panel .settings-close', 'settings close');
  await page.getByRole('button', {name: 'Mi perfil', exact: true}).tap();
  await panelBounds('.profile-panel', 'profile');
  await usableControl('.profile-panel .settings-close', 'profile close');
  await page.getByRole('button', {name: 'Cerrar perfil'}).tap();
  await page.locator('.rail-settings summary').tap();
  await page.getByRole('button', {name: 'Cerrar ajustes'}).tap();
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({width, height: 700});
    const narrow = await geometry(`${width}px chat list`);
    assert(narrow.sidebar.width >= width - 1 && narrow.rail.y + narrow.rail.height <= narrow.height + 1, `${width}px mobile layout is clipped: ${JSON.stringify(narrow)}`);
    await page.locator('#chats .chat-item').first().tap();
    const opened = await geometry(`${width}px conversation`);
    assert(opened.conversation.width >= width - 1, `${width}px conversation is clipped: ${JSON.stringify(opened)}`);
    await page.getByRole('button', {name: 'Volver a los chats'}).tap();
    await page.locator('#feature-archived-entry').tap();
    await usableControl('.feature-archive-back', `${width}px archived back`);
    await geometry(`${width}px archived list`);
    await page.locator('.feature-archive-back').tap();
  }
  await page.setViewportSize({width: 844, height: 390});
  await page.addStyleTag({content: ':root { --mobile-safe-area-top: 0px; --mobile-safe-area-bottom: 21px; --mobile-safe-area-left: 44px; --mobile-safe-area-right: 44px; }'});
  await geometry('landscape list');
  await page.locator('#chats .chat-item').first().tap();
  await geometry('landscape chat');
  const landscapeBack = await page.locator('.mobile-back').boundingBox();
  assert(landscapeBack.x >= 44 && landscapeBack.x + landscapeBack.width <= 800, 'landscape controls respect the notch');
  await page.getByRole('button', {name: 'Volver a los chats'}).tap();
  await page.addStyleTag({content: ':root { --mobile-safe-area-top: 59px; --mobile-safe-area-bottom: 34px; --mobile-safe-area-left: 0px; --mobile-safe-area-right: 0px; }'});
  await page.setViewportSize({width: 320, height: 420});
  await page.locator('#chats .chat-item').first().tap();
  const shortScreen = await geometry('short mobile viewport with long URL');
  assert(shortScreen.composer.bottom <= shortScreen.height + 1, `Composer is clipped: ${JSON.stringify(shortScreen)}`);
  await page.getByRole('button', {name: 'Opciones de chat', exact: true}).tap();
  await page.waitForFunction(() => document.querySelector('.feature-modal-menu .feature-dialog')?.getBoundingClientRect().top >= 58);
  const menu = await page.locator('.feature-modal-menu .feature-dialog').boundingBox();
  assert(menu.y >= 58 && menu.y + menu.height <= 420 - 34, 'short-screen menu is outside the safe area');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#chats .chat-item').length === 1);
  assert.equal(await page.evaluate(() => history.state?.socialMediaChat), false, 'reload must clear a stale chat history entry');
  await page.locator('#chats .chat-item').first().tap();
  await page.goBack();
  await page.waitForFunction(() => !document.body.classList.contains('chat-open'));
  await page.setViewportSize({width: 1280, height: 800});
  assert.equal(await page.locator('body').evaluate(element => getComputedStyle(element).position), 'static', 'desktop must keep its original layout');
  assert.equal(await page.locator('body').evaluate(element => getComputedStyle(element).transform), 'none');
  assert.deepEqual(errors, []);
  await context.close();

  // Model the reported native black band as non-drawable space. Screen size
  // deliberately exceeds the real browser canvas; controls must fit the latter.
  // This does not emulate iOS's compositor or prove physical-device recovery.
  const phone = devices['iPhone 13'];
  const canvasHeight = phone.screen.height - 60;
  const installedContext = await browser.newContext({...phone, viewport: {...phone.screen, height: canvasHeight}});
  const installed = await installedContext.newPage();
  installed.on('pageerror', error => errors.push(error.message));
  await installed.addInitScript(() => {
    let metrics = null;
    const fullHeight = innerHeight;
    const viewport = visualViewport;
    const nativeHeight = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewport), 'height').get;
    const nativeTop = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewport), 'offsetTop').get;
    Object.defineProperty(navigator, 'standalone', {get: () => true});
    Object.defineProperty(window, 'innerHeight', {get: () => metrics?.layout ?? fullHeight});
    Object.defineProperties(viewport, {
      height: {get: () => metrics?.height ?? nativeHeight.call(viewport)},
      offsetTop: {get: () => metrics?.top ?? nativeTop.call(viewport)},
    });
    window.setInstalledViewport = value => {
      metrics = value;
      viewport.dispatchEvent(new Event('resize'));
    };
  });
  await installed.route('**/api/**', fixtureRoute);
  await installed.goto(url);
  await installed.waitForFunction(() => document.querySelectorAll('#chats .chat-item').length === 1);
  await installed.addStyleTag({content: ':root { --mobile-safe-area-top: 59px; --mobile-safe-area-bottom: 34px; }'});
  const initialRail = await installed.locator('.app-rail').boundingBox();
  assert(Math.abs(initialRail.y + initialRail.height - canvasHeight) <= 1, 'initial rail fits the drawable canvas');
  assert.equal(await installed.evaluate(() => getComputedStyle(document.body).transform), 'none', 'root must not create a separate composited viewport');
  if (process.env.UI_SCREENSHOT_PATH) await installed.screenshot({path: `${process.env.UI_SCREENSHOT_PATH}-installed-list.png`});
  await installed.locator('#chats .chat-item').first().tap();
  async function installedComposer(label, expectedGap = 34, top = 0, bottom = canvasHeight) {
    await installed.waitForFunction(({top, bottom, expectedGap}) => {
      const shell = document.querySelector('.app-shell').getBoundingClientRect();
      const input = document.querySelector('#message').getBoundingClientRect();
      return Math.abs(shell.top - top) <= 1 && Math.abs(shell.bottom - bottom) <= 1 && Math.abs(input.bottom - (bottom - expectedGap)) <= 1;
    }, {top, bottom, expectedGap});
    const controls = await installed.locator('#message').evaluate(element => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return element === hit || element.contains(hit);
    });
    assert(controls, `${label}: visible composer is not hit-testable`);
  }
  await installedComposer('installed chat on entry');
  if (process.env.UI_SCREENSHOT_PATH) await installed.screenshot({path: `${process.env.UI_SCREENSHOT_PATH}-installed-chat.png`});
  await installed.locator('#message').fill('Borrador que se conserva');
  for (let cycle = 0; cycle < 2; cycle++) {
    await installed.locator('#message').focus();
    await installed.evaluate(height => window.setInstalledViewport({layout: height, height: height - 300, top: 20}), canvasHeight);
    await installedComposer('installed keyboard open', 12, 20, canvasHeight - 280);
    // The screen is still taller than the canvas after dismissal. A phantom
    // pan must not move controls below that canvas, even with retained focus.
    await installed.evaluate(height => window.setInstalledViewport({layout: height, height, top: 24}), canvasHeight);
    if (cycle === 1) await installed.locator('#message').evaluate(element => element.blur());
    await installedComposer('installed keyboard dismissed');
    const scrollBeforeRecovery = await installed.locator('#messages').evaluate(element => {
      element.scrollTop = 40;
      return element.scrollTop;
    });
    await installed.evaluate(() => new Promise(resolve => setTimeout(resolve, 1300)));
    await installedComposer('installed after native settlement');
    assert.equal(await installed.locator('#message').inputValue(), 'Borrador que se conserva');
    assert.equal(await installed.locator('#messages').evaluate(element => element.scrollTop), scrollBeforeRecovery, 'canvas recovery preserves the conversation reading position');
  }
  if (process.env.UI_SCREENSHOT_PATH) await installed.screenshot({path: `${process.env.UI_SCREENSHOT_PATH}-installed-dismiss.png`});
  await installed.getByRole('button', {name: 'Abrir Social Media Agent'}).tap();
  const agentInput = installed.locator('.ai-composer textarea');
  await agentInput.fill('Borrador del asistente');
  async function installedAgent(bottom, gap) {
    await installed.waitForFunction(({bottom, gap}) => {
      const panel = document.querySelector('#ai-panel').getBoundingClientRect();
      const input = document.querySelector('.ai-composer textarea').getBoundingClientRect();
      return Math.abs(panel.bottom - bottom) <= 1 && Math.abs(input.bottom - (bottom - gap)) <= 1;
    }, {bottom, gap});
    for (const selector of ['.ai-composer textarea', '#ai-send']) {
      const usable = await installed.locator(selector).evaluate(element => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return r.bottom <= document.body.getBoundingClientRect().bottom && (element === hit || element.contains(hit));
      });
      assert(usable, `installed assistant ${selector} fits the drawable canvas and hit testing`);
    }
  }
  await installedAgent(canvasHeight, 34);
  await agentInput.focus();
  await installed.evaluate(height => window.setInstalledViewport({layout: height, height: height - 300, top: 20}), canvasHeight);
  await installedAgent(canvasHeight - 280, 10);
  await installed.evaluate(height => window.setInstalledViewport({layout: height, height, top: 24}), canvasHeight);
  await installed.evaluate(() => new Promise(resolve => setTimeout(resolve, 1300)));
  await installedAgent(canvasHeight, 34);
  assert.equal(await agentInput.inputValue(), 'Borrador del asistente');
  await agentInput.evaluate(element => element.blur());
  await installed.getByRole('button', {name: 'Cerrar Social Media Agent'}).tap();
  await installed.getByRole('button', {name: 'Volver a los chats'}).tap();
  await installed.locator('#feature-archived-entry').tap();
  const back = await installed.locator('.feature-archive-back').boundingBox();
  assert(back.y >= 59, 'installed archived back keeps the safe header after keyboard recovery');
  const rail = await installed.locator('.app-rail').boundingBox();
  assert(Math.abs(rail.y + rail.height - canvasHeight) <= 1, 'installed list bottom does not inherit stale height');
  await installedContext.close();
  assert.deepEqual(errors, []);
  console.log(`PASS mobile PWA (${browserType.name()}): safe-area header hit testing, archived/list/chat, keyboard/pan recovery, search/info, contacts, settings/profile, agent, novedades/media, portrait/landscape, short menus and desktop`);
} finally {
  await browser.close();
  server.close();
}
