#!/usr/bin/env node

/* Optional browser integration test. The QA container supplies Playwright. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const playwrightPath = process.env.PLAYWRIGHT_MODULE;
if (!playwrightPath) {
  console.log('SKIP message-render.integration.playwright.mjs: PLAYWRIGHT_MODULE is not configured');
  process.exit(0);
}

const { chromium } = await import(playwrightPath);
const publicDir = join(fileURLToPath(new URL('..', import.meta.url)), 'public');
const server = createServer(async (request, response) => {
  const path = new URL(request.url || '/', 'http://fixture.local').pathname;
  if (path === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body></body></html>');
    return;
  }
  if (path === '/message-render.mjs' || path === '/settings-ui.mjs' || path === '/styles.css') {
    response.writeHead(200, { 'content-type': path.endsWith('.css') ? 'text/css' : 'text/javascript; charset=utf-8' });
    response.end(await readFile(join(publicDir, path.slice(1))));
    return;
  }
  if (path.endsWith('.png')) {
    response.writeHead(200, {'content-type':'image/svg+xml'});
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#a3c0aa"/><circle cx="400" cy="270" r="130" fill="#efca79"/><path d="M0 600L290 310 500 600Z" fill="#426754"/></svg>');
    return;
  }
  response.writeHead(404);
  response.end('Not found');
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
assert(address && typeof address === 'object' && address.port, 'fixture server did not bind');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
});

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const result = await page.evaluate(async () => {
    const renderer = await import('/message-render.mjs');
    const host = document.createElement('main');
    document.body.append(host);
    const rendered = renderer.renderMessageList([
      { id: 'one', senderName: 'Ana', text: 'uno', timestamp: '2026-09-23T10:00:00Z' },
      { id: 'two', senderName: 'Ana', text: 'dos', timestamp: '2026-09-23T10:01:00Z' },
      { id: 'quoted-text', text: 'Respuesta', replyToMessageId: 'one', replyPreview: { type: 'TEXT', text: 'uno', senderName: 'Ana', available: true } },
      { id: 'quoted-image', text: 'Bonita foto', replyToMessageId: 'image', replyPreview: { type: 'IMAGE', text: '', senderName: 'Bel', available: true } },
      { id: 'quoted-missing', text: 'Gracias', replyToMessageId: 'gone', replyPreview: { type: 'TEXT', text: 'stale', available: false } },
    ], { showSenderNames: false, now: new Date('2026-09-23T12:00:00Z') });
    host.append(rendered.fragment);
    const attachment = renderer.createAttachmentElement({ url: '/fixture.png', mimeType: 'image/png', name: 'fixture.png' });
    document.body.append(attachment);
    const opener = await new Promise((resolve, reject) => {
      const current = attachment.querySelector('.media-image-button');
      if (current) return resolve(current);
      const observer = new MutationObserver(() => {
        const button = attachment.querySelector('.media-image-button');
        if (button) { clearTimeout(timeout); observer.disconnect(); resolve(button); }
      });
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Image did not finish loading')); }, 5000);
      observer.observe(attachment, { childList: true, subtree: true });
    });
    opener.focus();
    opener.click();
    return {
      messages: host.querySelectorAll('.message').length,
      textQuote: host.querySelector('[data-message-id="quoted-text"] .message-reply-reference')?.textContent,
      imageQuote: host.querySelector('[data-message-id="quoted-image"] .message-reply-reference')?.textContent,
      imageIcon: host.querySelector('[data-message-id="quoted-image"] .message-kind-icon')?.tagName.toLowerCase(),
      missingQuote: host.querySelector('[data-message-id="quoted-missing"] .message-reply-reference')?.textContent,
      missingIcon: host.querySelector('[data-message-id="quoted-missing"] .message-kind-icon')?.tagName.toLowerCase(),
      sendersInDirectChat: host.querySelectorAll('.message-sender').length,
      objectText: host.textContent.includes('[object Object]'),
      text: host.textContent,
    };
  });
  assert.equal(result.messages, 5);
  assert.equal(result.textQuote, 'Anauno');
  assert.equal(result.imageQuote, 'BelImagen');
  assert.equal(result.imageIcon, 'svg');
  assert.equal(result.missingQuote, 'Mensaje no disponible');
  assert.equal(result.missingIcon, 'svg');
  assert.equal(result.sendersInDirectChat, 0);
  assert.equal(result.objectText, false);
  assert.match(result.text, /uno/);
  assert.match(result.text, /dos/);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.media-viewer-actions a')), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.media-viewer-close')), true);
  await page.evaluate(() => document.querySelector('.media-viewer-close').click());
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.media-image-button')), true);
  await page.evaluate(async () => {
    const renderer = await import('/message-render.mjs');
    const chat = document.createElement('section'); chat.id = 'messages';
    for (const name of ['first.png', 'second.png', 'third.png']) chat.append(renderer.createAttachmentElement({id: `id-${name}`, url:`/${name}`,mimeType:'image/png',name}));
    document.body.append(chat);
  });
  await page.waitForFunction(() => document.querySelectorAll('#messages .media-image-button').length === 3);
  await page.evaluate(() => document.querySelector('#messages .media-image-button').click());
  assert(await page.getByRole('button', {name:'Imagen anterior',exact:true}).isDisabled());
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.media-viewer-image').getAttribute('alt'), 'second.png');
  assert.equal(await page.locator('.media-viewer-actions a').getAttribute('href'), await page.locator('#messages .media-image-button').nth(1).getAttribute('data-viewer-url'));
  assert.equal(await page.locator('.media-viewer-counter').textContent(), '2 / 3');
  for (const theme of ['light','dark']) for (const width of [1200,390]) {
    await page.setViewportSize({width,height:844});
    await page.evaluate(theme => document.body.dataset.theme = theme, theme);
    for (const name of ['Imagen anterior','Imagen siguiente','Cerrar imagen']) {
      const box = await page.getByRole('button',{name,exact:true}).boundingBox();
      assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 844);
    }
    if (process.env.UI_OUTPUT_DIR) {
      await mkdir(process.env.UI_OUTPUT_DIR,{recursive:true});
      await page.screenshot({path:join(process.env.UI_OUTPUT_DIR,`viewer-${theme}-${width}.png`)});
    }
  }
  await page.getByRole('button', {name:'Imagen siguiente',exact:true}).click();
  assert.equal(await page.locator('.media-viewer-image').getAttribute('alt'), 'third.png');
  assert(await page.getByRole('button', {name:'Imagen siguiente',exact:true}).isDisabled());
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('.media-viewer-image').getAttribute('alt'), 'second.png');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.media-viewer').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#messages .media-image-button')), true);
  await page.evaluate(async () => {
    const renderer = await import('/message-render.mjs');
    const opener = document.querySelectorAll('#messages .media-image-button')[1];
    renderer.openImageViewer('/second.png', 'second.png', document, opener, async cursor => cursor
      ? {items: [{id: 'id-first.png', url: '/first.png', name: 'first.png'}, {id: 'id-older.png', url: '/older.png', name: 'older.png'}], nextCursor: null}
      : {items: [{id: 'id-third.png', url: '/third.png', name: 'third.png'}, {id: 'id-second.png', url: '/server-second.png', name: 'second.png'}], nextCursor: 'older'});
  });
  await page.getByText('1 / 2+', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Imagen anterior', exact: true}).click();
  assert.equal(await page.locator('.media-viewer-image').getAttribute('alt'), 'first.png');
  await page.getByRole('button', {name: 'Imagen anterior', exact: true}).click();
  assert.equal(await page.locator('.media-viewer-image').getAttribute('alt'), 'older.png');
  assert(await page.getByRole('button', {name: 'Imagen anterior', exact: true}).isDisabled());
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.media-viewer').count(), 0);
  await page.evaluate(async () => {
    const renderer = await import('/message-render.mjs');
    const opener = document.querySelector('#messages .media-image-button');
    renderer.openImageViewer('/first.png', 'first.png', document, opener, () => new Promise(resolve => { window.resolveViewerPage = resolve; }));
    renderer.closeMediaViewer(document);
    window.resolveViewerPage({items: [{url: '/stale.png', name: 'stale.png'}], nextCursor: null});
  });
  assert.equal(await page.locator('.media-viewer').count(), 0, 'a late page must not reopen a closed viewer');
  await page.evaluate(async () => {
    const renderer = await import('/message-render.mjs');
    const opener = document.querySelectorAll('#messages .media-image-button')[1];
    renderer.openImageViewer('/second.png', 'second.png', document, opener, async cursor => cursor
      ? Promise.reject(new Error('Network failed'))
      : {items: [{id: 'id-second.png', url: '/second.png', name: 'second.png'}], nextCursor: 'older'});
  });
  await page.getByText('1 / 1+', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Imagen anterior', exact: true}).click();
  await page.getByText('No se pudieron cargar más imágenes', {exact: true}).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const renderer = await import('/message-render.mjs');
    const opener = document.querySelectorAll('#messages .media-image-button')[1];
    renderer.openImageViewer('/second.png', 'second.png', document, opener);
    document.querySelectorAll('#messages .media-image-button')[0].remove();
  });
  await page.getByRole('button', {name: 'Imagen anterior', exact: true}).click();
  assert.equal(await page.locator('.media-viewer-image').getAttribute('alt'), 'second.png');
  await page.getByRole('button', {name: 'Imagen siguiente', exact: true}).click();
  assert.equal(await page.locator('.media-viewer-image').getAttribute('alt'), 'third.png');
  await page.keyboard.press('Escape');
  console.log('PASS message-render DOM integration', JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
