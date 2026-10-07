#!/usr/bin/env node

/* Synthetic browser and network checks for bounded WhatsApp media loading. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const playwrightPath = process.env.PLAYWRIGHT_MODULE;
if (!playwrightPath) {
  console.log('SKIP media-autodownload.playwright.mjs: PLAYWRIGHT_MODULE is not configured');
  process.exit(0);
}

const { chromium } = await import(playwrightPath);
const publicDir = join(fileURLToPath(new URL('..', import.meta.url)), 'public');

const BIG_BYTES = 40 * 1024 * 1024;
const bigSvgBody = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><!--${'A'.repeat(BIG_BYTES - 120)}--><rect width="4" height="4" fill="#426754"/></svg>`;
const wavBody = Buffer.concat([
  Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WAVEfmt ', 'ascii'),
  Buffer.alloc(16), Buffer.from('data', 'ascii'), Buffer.alloc(4), Buffer.alloc(8),
]);

const counts = new Map();
const bump = key => counts.set(key, (counts.get(key) || 0) + 1);

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://fixture.local');
  const path = url.pathname;
  if (path === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head></head><body></body></html>');
    return;
  }
  if (path === '/message-render.mjs' || path === '/settings-ui.mjs') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    response.end(await readFile(join(publicDir, path.slice(1))));
    return;
  }
  if (path === '/__counts') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(Object.fromEntries(counts)));
    return;
  }
  if (path.startsWith('/api/media/')) {
    const id = path.slice('/api/media/'.length);
    const account = url.searchParams.get('account') || '';
    bump(`${id}|${account}`);
    if (id.startsWith('slow-')) {
      response.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      response.write('<svg xmlns="http://www.w3.org/2000/svg"><!--');
      response.on('close', () => bump(`${id}-closed|${account}`));
      return;
    }
    if (id.startsWith('big')) {
      response.writeHead(200, { 'content-type': 'image/svg+xml', ...(id === 'big-unknown' ? {} : { 'content-length': String(Buffer.byteLength(bigSvgBody)) }), 'cache-control': 'no-store' });
      response.end(bigSvgBody);
      return;
    }
    const [body, type] = id.startsWith('img')
      ? ['<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="#a3c0aa"/></svg>', 'image/svg+xml']
      : id.startsWith('stk')
        ? ['<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"><rect width="5" height="5" fill="#8e44ad"/></svg>', 'image/svg+xml']
      : id.startsWith('aud')
        ? [wavBody, 'audio/wav']
        : id.startsWith('vid')
          ? [Buffer.from('mockvideo'), 'video/webm']
          : [Buffer.from('%PDF-1.4 mock'), 'application/pdf'];
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(body);
    return;
  }
  response.writeHead(404);
  response.end('Not found');
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
});

const attachment = (id, mimeType, name, extra = {}) => ({ url: `/api/media/${id}?account=ACOUNT&chat=fixture-chat`, mimeType, name, ...extra });
const message = attachments => ({ id: 'msg-1', senderName: 'QA Fixture', text: '', timestamp: '2026-09-28T08:00:00.000Z', attachments });

async function openScene(page, attachments, account) {
  await page.evaluate(async ({ attachments, account }) => {
    const renderer = await import('/message-render.mjs');
    const host = document.createElement('main');
    host.id = 'messages';
    document.body.append(host);
    const rendered = renderer.renderMessageList(
      [{ id: 'msg-1', senderName: 'QA Fixture', text: '', timestamp: '2026-09-28T08:00:00.000Z', attachments: attachments.map(item => ({ ...item, url: item.url.replace('ACOUNT', account) })) }],
      { document },
    );
    host.append(rendered.fragment);
  }, { attachments, account });
}

const counters = async () => await (await fetch(`${baseUrl}/__counts`)).json();
const count = async (id, account) => (await counters())[`${id}|${account}`] || 0;

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) { console.log(`PASS ${label}`); return; }
  failures += 1;
  console.log(`FAIL ${label} ${detail}`);
};

try {
  // 1. Official defaults: photos and audio load, videos and documents wait.
  {
    const context = await browser.newContext();
    await context.addInitScript(() => { window.__noPrefs = true; });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/`);
    await openScene(page, [
      attachment('img-default', 'image/svg+xml', 'foto.svg', { caption: 'playa' }),
      attachment('aud-default', 'audio/wav', 'nota.wav'),
      attachment('vid-default', 'video/webm', 'playa.webm'),
      attachment('doc-default', 'application/pdf', 'informe.pdf'),
    ], 'defaults');
    await page.waitForFunction(() => document.querySelectorAll('.message .attachment').length === 4);
    await page.waitForFunction(() => document.querySelectorAll('.attachment-image, .audio-element').length === 2);
    await page.waitForTimeout(400);
    const state = await page.evaluate(() => ({
      imgSrc: document.querySelector('.attachment-image')?.src || null,
      audioSrc: document.querySelector('.audio-element')?.src || null,
      video: Boolean(document.querySelector('.attachment-video')),
      videoPending: document.querySelector('.attachment-pending[data-media-kind="video"]')?.textContent || null,
      docPending: Boolean(document.querySelector('.attachment-pending[data-media-kind="document"]')),
      docLink: document.querySelector('[data-media-kind="document"] .attachment-download')?.getAttribute('href') || null,
      caption: document.querySelector('.attachment-caption')?.textContent || null,
    }));
    check('defaults load photos through a bounded blob', (await count('img-default', 'defaults')) === 1 && state.imgSrc.startsWith('blob:'), JSON.stringify(state));
    check('defaults load audio through a bounded blob', (await count('aud-default', 'defaults')) === 1 && state.audioSrc.startsWith('blob:'));
    check('defaults request zero video bytes', (await count('vid-default', 'defaults')) === 0 && !state.video && String(state.videoPending).includes('Descargar video'));
    check('defaults request zero document bytes', (await count('doc-default', 'defaults')) === 0 && String(state.docLink).includes('/api/media/doc-default'), JSON.stringify(state));
    check('gated media keep the caption text', state.caption === 'playa', String(state.caption));
    check('defaults page has no script errors', pageErrors.length === 0, pageErrors.join('; '));
    // 2. The explicit tap is what requests the gated video, exactly once.
    await page.evaluate(() => document.querySelector('.attachment-pending[data-media-kind="video"] .attachment-load').click());
    await page.waitForFunction(() => document.querySelector('.attachment-video')?.src.startsWith('blob:'));
    await page.evaluate(() => document.querySelector('.attachment-load')?.click());
    await page.waitForTimeout(250);
    check('tap loads the video once via memory blob', (await count('vid-default', 'defaults')) === 1);
    check('caption survives the explicit load', await page.evaluate(() => document.querySelector('.attachment-caption')?.textContent) === 'playa');
    await context.close();
  }

  // 3. Videos enabled by preference: same bytes, no click needed.
  {
    const context = await browser.newContext();
    await context.addInitScript(() => window.localStorage.setItem('wa-media-autodownload', JSON.stringify({ '*': { video: true } })));
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await openScene(page, [attachment('vid-on', 'video/webm', 'playa.webm')], 'video-on');
    await page.waitForFunction(() => document.querySelector('.attachment-video')?.src.startsWith('blob:'));
    await page.waitForTimeout(200);
    check('enabled videos mount a bounded blob without a click', (await count('vid-on', 'video-on')) === 1);
    await context.close();
  }

  // 4. Documents enabled: bounded memory prefetch and instant anchor rewire.
  {
    const context = await browser.newContext();
    await context.addInitScript(() => window.localStorage.setItem('wa-media-autodownload', JSON.stringify({ '*': { document: true } })));
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await openScene(page, [attachment('doc-on', 'application/pdf', 'informe.pdf')], 'doc-on');
    await page.waitForFunction(() => document.querySelector('.attachment').dataset.mediaState === 'loaded');
    const link = await page.evaluate(() => document.querySelector('.attachment-download').getAttribute('href'));
    check('enabled documents prefetch once into memory', (await count('doc-on', 'doc-on')) === 1 && link.startsWith('blob:'), link);
    await context.close();
  }

  // 5. Per-account buckets stay isolated for the same photo type.
  {
    const context = await browser.newContext();
    await context.addInitScript(() => window.localStorage.setItem('wa-media-autodownload', JSON.stringify({
      uno: { image: false, audio: true, video: false, document: false },
      dos: { image: true, audio: true, video: false, document: false },
    })));
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await openScene(page, [attachment('img-uno', 'image/svg+xml', 'uno.svg')], 'uno');
    await openScene(page, [attachment('img-dos', 'image/svg+xml', 'dos.svg')], 'dos');
    await page.waitForFunction(() => document.querySelectorAll('.message .attachment').length === 2);
    await page.waitForTimeout(300);
    check('account without preference stays gated', (await count('img-uno', 'uno')) === 0 && await page.evaluate(() => Boolean(document.querySelector('[data-media-account="uno"] .attachment-pending'))));
    await page.waitForFunction(() => document.querySelector('[data-media-account="dos"] .attachment-image')?.src.startsWith('blob:'));
    check('other account loads photos automatically', (await count('img-dos', 'dos')) === 1);
    // Flipping the switch for account uno auto-loads only its visible placeholder.
    await page.evaluate(async () => {
      const settings = await import('/settings-ui.mjs');
      settings.writeMediaSettings(undefined, 'uno', { image: true });
      document.dispatchEvent(new CustomEvent('wa:media-autodownload-change', { detail: { mediaType: 'image', enabled: true, account: 'uno' } }));
    });
    await page.waitForFunction(() => document.querySelector('[data-media-account="uno"] .attachment-image')?.src.startsWith('blob:'));
    check('enabling the switch auto-loads the account placeholder', (await count('img-uno', 'uno')) === 1);
    await context.close();
  }

  // 6. A declared 40 MB photo skips the 32 MB auto cap until tapped.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await openScene(page, [attachment('big-photo', 'image/svg+xml', 'gigante.svg', { size: BIG_BYTES })], 'grande');
    await page.waitForFunction(() => document.querySelectorAll('.message .attachment').length === 1);
    await page.waitForTimeout(300);
    const reason = await page.evaluate(() => document.querySelector('.attachment').dataset.mediaReason);
    check('oversized declared photo is not auto-downloaded', (await count('big-photo', 'grande')) === 0 && reason === 'size-limit', reason || '');
    await page.evaluate(() => document.querySelector('.attachment-load').click());
    await page.waitForFunction(() => document.querySelector('.attachment-image')?.src.startsWith('blob:'), null, { timeout: 30000 });
    check('explicit tap still downloads the oversized photo', (await count('big-photo', 'grande')) === 1);
    await context.close();
  }

  // 7. Stickers download automatically even with the Fotos switch off.
  {
    const context = await browser.newContext();
    await context.addInitScript(() => window.localStorage.setItem('wa-media-autodownload', JSON.stringify({
      '*': { image: false, audio: false, video: false, document: false },
    })));
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/`);
    await openScene(page, [
      attachment('stk-fix', 'image/webp', 'baile.webp', { type: 'STICKER' }),
      attachment('img-off', 'image/svg+xml', 'foto.svg'),
    ], 'stickers');
    await page.waitForFunction(() => document.querySelectorAll('.message .attachment').length === 2);
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => ({
      stickerSrc: document.querySelector('[data-media-account="stickers"] .attachment-image')?.src || null,
      stickerState: document.querySelector('.attachment[data-media-account="stickers"][data-media-kind="image"]')?.dataset.mediaState || null,
      photoPending: Boolean(document.querySelector('[data-media-account=\"stickers\"] .attachment-pending[data-media-kind=\"image\"]')),
    }));
    check('stickers mount automatically while Fotos is off', (await count('stk-fix', 'stickers')) === 1 && String(state.stickerSrc).includes('/api/media/stk-fix') && state.stickerState === 'auto', JSON.stringify(state));
    check('regular photos stay gated with Fotos off', (await count('img-off', 'stickers')) === 0 && state.photoPending, JSON.stringify(state));
    check('sticker scene has no script errors', pageErrors.length === 0, pageErrors.join('; '));
    await context.close();
  }

  // 8. The viewer navigates only to live policy-owned blobs and restores focus.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await openScene(page, [
      attachment('img-viewer-one', 'image/svg+xml', 'uno.svg'),
      attachment('img-viewer-two', 'image/svg+xml', 'dos.svg'),
    ], 'visor');
    await page.waitForFunction(() => [...document.querySelectorAll('.media-image-button')].length === 2
      && [...document.querySelectorAll('.media-image-button')].every(button => button.dataset.viewerUrl.startsWith('blob:')));
    await page.locator('.media-image-button').first().click();
    const firstUrl = await page.locator('.media-viewer-image').getAttribute('src');
    await page.evaluate(() => { document.querySelectorAll('.media-image-button')[1].dataset.viewerUrl = 'blob:arbitrary'; });
    await page.keyboard.press('ArrowRight');
    check('viewer rejects an arbitrary blob URL', await page.locator('.media-viewer-image').getAttribute('src') === firstUrl);
    await page.evaluate(() => { document.querySelectorAll('.media-image-button')[1].dataset.viewerUrl = document.querySelectorAll('.attachment-image')[1].src; });
    await page.keyboard.press('ArrowRight');
    const secondUrl = await page.locator('.media-viewer-image').getAttribute('src');
    check('viewer navigates to a live policy blob', secondUrl !== firstUrl && secondUrl.startsWith('blob:'));
    await page.keyboard.press('Escape');
    check('viewer restores focus to its opener', await page.evaluate(() => document.activeElement === document.querySelector('.media-image-button')));
    await context.close();
  }

  // 9. Turning Documents on starts already-visible cards only for that account.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await openScene(page, [attachment('doc-toggle-uno', 'application/pdf', 'uno.pdf')], 'uno');
    await openScene(page, [attachment('doc-toggle-dos', 'application/pdf', 'dos.pdf')], 'dos');
    await page.evaluate(async () => {
      const settings = await import('/settings-ui.mjs');
      settings.writeMediaSettings(undefined, 'uno', { document: true });
      document.dispatchEvent(new CustomEvent('wa:media-autodownload-change', { detail: { mediaType: 'document', enabled: true, account: 'uno' } }));
    });
    await page.waitForFunction(() => document.querySelector('[data-media-account="uno"] .attachment-download')?.getAttribute('href')?.startsWith('blob:'));
    check('document switch prefetches visible cards for its account', (await count('doc-toggle-uno', 'uno')) === 1);
    check('document switch leaves another account untouched', (await count('doc-toggle-dos', 'dos')) === 0
      && await page.evaluate(() => document.querySelector('[data-media-account="dos"] .attachment-download')?.getAttribute('href')?.includes('/api/media/doc-toggle-dos')));
    await context.close();
  }

  // 10. A false declared size cannot bypass the measured 32 MiB auto limit.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await openScene(page, [attachment('big-unknown', 'image/svg+xml', 'falso.svg', { size: 1 })], 'falso');
    await page.waitForFunction(() => document.querySelector('.attachment-pending')?.dataset.mediaReason === 'too-large', null, { timeout: 30000 });
    const falseSizeState = await page.evaluate(() => ({ reason: document.querySelector('.attachment-pending')?.dataset.mediaReason, image: Boolean(document.querySelector('.attachment-image')) }));
    check('false-size photo stops at the measured byte cap', (await count('big-unknown', 'falso')) === 1
      && falseSizeState.reason === 'too-large' && !falseSizeState.image, JSON.stringify(falseSizeState));
    await context.close();
  }

  // 11. Replacing a keyboard-activated download button keeps focus visible.
  {
    const context = await browser.newContext();
    await context.addInitScript(() => window.localStorage.setItem('wa-media-autodownload', JSON.stringify({ '*': { image: false } })));
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await openScene(page, [attachment('img-focus', 'image/svg+xml', 'foco.svg')], 'foco');
    await page.locator('.attachment-load').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.media-image-button')?.isConnected);
    check('keyboard focus moves to the replacement image button', await page.evaluate(() => document.activeElement === document.querySelector('.media-image-button')));
    await context.close();
  }

  // 12. Disabling an account preference aborts its active automatic reader.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await openScene(page, [attachment('slow-toggle', 'image/svg+xml', 'pendiente.svg')], 'uno');
    await page.waitForFunction(() => document.querySelector('.attachment-pending')?.dataset.mediaState === 'loading');
    await page.evaluate(async () => {
      const settings = await import('/settings-ui.mjs');
      settings.writeMediaSettings(undefined, 'uno', { image: false });
      document.dispatchEvent(new CustomEvent('wa:media-autodownload-change', { detail: { mediaType: 'image', enabled: false, account: 'uno' } }));
    });
    await page.waitForFunction(async () => (await (await fetch('/__counts')).json())['slow-toggle-closed|uno'] > 0);
    check('disabling Fotos stops the network reader', await page.evaluate(() => document.querySelector('.attachment-pending')?.dataset.mediaState === 'manual'
      && !document.querySelector('.attachment-image')));
    await context.close();
  }

  // 13. Removing the final mount aborts its active reader without a new render.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await openScene(page, [attachment('slow-unmount', 'image/svg+xml', 'desmontada.svg')], 'uno');
    await page.waitForFunction(() => document.querySelector('.attachment-pending')?.dataset.mediaState === 'loading');
    await page.evaluate(() => document.querySelector('#messages').remove());
    await page.waitForFunction(async () => (await (await fetch('/__counts')).json())['slow-unmount-closed|uno'] > 0);
    check('unmounting the final owner stops the network reader', (await count('slow-unmount-closed', 'uno')) === 1);
    await context.close();
  }

  // 14. Document prefetch uses the same cancellation path as visible media.
  {
    const context = await browser.newContext();
    await context.addInitScript(() => window.localStorage.setItem('wa-media-autodownload', JSON.stringify({ '*': { document: true } })));
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await openScene(page, [attachment('slow-document', 'application/pdf', 'pendiente.pdf')], 'uno');
    await page.waitForFunction(() => document.querySelector('.attachment')?.dataset.mediaState === 'loading');
    await page.evaluate(async () => {
      const settings = await import('/settings-ui.mjs');
      settings.writeMediaSettings(undefined, 'uno', { document: false });
      document.dispatchEvent(new CustomEvent('wa:media-autodownload-change', { detail: { mediaType: 'document', enabled: false, account: 'uno' } }));
    });
    await page.waitForFunction(async () => (await (await fetch('/__counts')).json())['slow-document-closed|uno'] > 0);
    check('disabling Documentos stops visible prefetch', await page.evaluate(() => document.querySelector('.attachment')?.dataset.mediaState === 'manual'
      && document.querySelector('.attachment-download')?.getAttribute('href')?.includes('/api/media/slow-document')));
    await context.close();
  }

  assert.equal(failures, 0, `${failures} media auto-download checks failed`);
  console.log('OK media-autodownload.playwright.mjs');
} finally {
  await browser.close();
  server.close();
}
