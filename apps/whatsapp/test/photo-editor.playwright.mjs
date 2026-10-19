#!/usr/bin/env node
// Synthetic browser QA for the pre-send photo editor. Every API response is
// local; the source images are generated on-canvas so pixels are known.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(process.env.UI_SOURCE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'));
const outputDir = path.resolve(process.env.UI_OUTPUT_DIR || '/tmp/socialmedia-photo-editor-qa');
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const filename = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!filename.startsWith(`${publicDir}${path.sep}`)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(filename);
    response.writeHead(200, {'content-type': {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2'}[path.extname(filename)] || 'application/octet-stream'}).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless:true,
  executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome'});
const origin = `http://127.0.0.1:${server.address().port}`;
const context = await browser.newContext({baseURL:origin, viewport:{width:1280, height:844}});
const page = await context.newPage();
const uploads = [];
const stickerSends = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  const json = (data, status = 200) => route.fulfill({status, contentType:'application/json', body:JSON.stringify(data)});
  if (url.pathname === '/api/accounts') return json({accounts:[{id:'alpha',label:'Alpha'}], sendingEnabled:true, outboxScope:'synthetic'});
  if (url.pathname === '/api/chats') return json({chats:[{id:'one',name:'Uno'}]});
  if (url.pathname === '/api/messages') return json({messages:[], nextCursor:null});
  if (url.pathname === '/api/upload') { uploads.push(route.request().postDataJSON()); return json({messageId:`wa-${uploads.length}`, confirmed:true}); }
  if (url.pathname === '/api/messages/compose') { stickerSends.push(route.request().postDataJSON()); return json({messageId:`sticker-${stickerSends.length}`, confirmed:true}); }
  return json({models:[], items:[], communities:[], lists:[], favorites:[], sessions:[]});
});

const solidPng = (w, h, rgb) => page.evaluate(([w, h, rgb]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; g.fillRect(0, 0, w, h);
  return c.toDataURL('image/png').split(',')[1];
}, [w, h, rgb]).then(b64 => Buffer.from(b64, 'base64'));
const gifBuffer = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
const imageDims = (b64, mime) => page.evaluate(async ([b64, mime]) => {
  const img = new Image(); img.src = `data:${mime};base64,${b64}`; await img.decode();
  return {width: img.naturalWidth, height: img.naturalHeight};
}, [b64, mime]);
const stickerAlpha = b64 => page.evaluate(async b64 => {
  const img = new Image(); img.src = `data:image/webp;base64,${b64}`; await img.decode();
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
  return {corner: ctx.getImageData(0, 0, 1, 1).data[3], center: ctx.getImageData(256, 256, 1, 1).data[3]};
}, b64);
const nonRedPixels = b64 => page.evaluate(async b64 => {
  const img = new Image(); img.src = `data:image/jpeg;base64,${b64}`; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (!(d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90)) n += 1;
  return {total: d.length / 4, nonRed: n};
}, b64);
const canvasSize = () => page.evaluate(() => { const c = document.getElementById('photo-editor-canvas'); return {width: c.width, height: c.height}; });
const confirmCount = () => page.evaluate(() => document.querySelectorAll('#messages [data-send-state="confirmed"]').length);

async function clearAttachments() {
  let n = await page.locator('.composer-attachment-remove').count();
  while (n > 0) { await page.locator('.composer-attachment-remove').first().click(); n = await page.locator('.composer-attachment-remove').count(); }
  await page.locator('#message').fill('');
}
async function openEditor(index = 0) {
  await page.locator('.composer-attachment-edit').nth(index).click();
  await page.locator('#photo-editor-overlay:not([hidden])').waitFor({state:'visible'});
  await page.waitForFunction(() => document.querySelector('.photo-editor-stage')?.dataset.loaded === '1');
}
async function dragHandle(handle, fx, fy) {
  const canvas = await page.locator('#photo-editor-canvas').boundingBox();
  const box = await page.locator(`.photo-editor-handle-${handle}`).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * fx, canvas.y + canvas.height * fy, {steps: 10});
  await page.mouse.up();
}

const frameLeft = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.photo-editor-crop-frame')).left) || 0);
async function dragFrameBy(dx, dy) {
  const box = await page.locator('.photo-editor-crop-frame').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, {steps: 8});
  await page.mouse.up();
}
const red = await solidPng(120, 80, [255, 0, 0]);

try {
  await mkdir(outputDir, {recursive:true});
  await page.goto(origin);
  await page.locator('#chats .chat-item').first().click();

  // Gating + a full crop round-trip: jpeg/png/webp get an Edit button, opening
  // never sends, and applying replaces only that attachment (reduced pixels).
  await page.locator('#attachment').setInputFiles([
    {name:'foto.png', mimeType:'image/png', buffer:red},
    {name:'animado.gif', mimeType:'image/gif', buffer:gifBuffer},
    {name:'nota.txt', mimeType:'text/plain', buffer:Buffer.from('nota')},
  ]);
  assert.equal(await page.locator('.composer-media-card').count(), 3);
  assert.equal(await page.locator('.composer-attachment-edit').count(), 1, 'only jpeg/png/webp images are editable');
  await openEditor();
  assert.equal(uploads.length, 0, 'opening the editor must not send');
  assert.equal(await page.locator('#photo-editor-notice').isHidden(), true, 'normal edit must not claim a downscale');
  assert.deepEqual(await canvasSize(), {width: 120, height: 80}, 'normal edit must preserve resolution');
  assert.equal(await page.locator('.photo-editor-crop-frame').isVisible(), true, 'crop control visible on open');
  await dragHandle('se', 0.5, 0.5);
  const leftBeforeMove = await frameLeft();
  await dragFrameBy(40, 20);
  assert(await frameLeft() > leftBeforeMove, 'crop-frame body drag must move the selection');
  assert(await page.locator('.photo-editor-crop-frame').isVisible(), 'frame drag must stay open');
  await page.locator('#photo-crop-apply').click();
  await page.locator('#photo-editor-apply').click();
  await page.locator('#photo-editor-overlay').waitFor({state:'hidden'});
  assert.equal(uploads.length, 0, 'applying must not send');
  assert((await page.locator('.composer-attachment-label').first().textContent()).includes('foto-editada.jpg'));
  await page.locator('#composer').evaluate(form => form.requestSubmit());
  await page.waitForFunction(n => document.querySelectorAll('#messages [data-send-state="confirmed"]').length >= n, 3);
  const cropUpload = uploads.find(item => item.name === 'foto-editada.jpg');
  assert(cropUpload && cropUpload.mimeType === 'image/jpeg', 'edited file was not sent as jpeg');
  const cropDims = await imageDims(cropUpload.data, 'image/jpeg');
  assert(cropDims.width < 75 && cropDims.height < 55 && cropDims.width > 20 && cropDims.height > 12, `crop dims ${JSON.stringify(cropDims)}`);
  assert.equal(uploads.find(i => i.name === 'animado.gif')?.mimeType, 'image/gif', 'sibling gif changed');
  await clearAttachments();

  // Rotate + undo/redo + draw: dimension swap, history correctness, and a
  // painted stroke that changes pixels from the solid source.
  await page.locator('#attachment').setInputFiles([{name:'lienzo.png', mimeType:'image/png', buffer:red}]);
  await openEditor();
  const base = await canvasSize();
  await page.locator('#photo-rotate-right').click();
  const rotated = await canvasSize();
  assert.deepEqual(rotated, {width: base.height, height: base.width}, 'rotate must swap dimensions');
  await page.locator('#photo-editor-undo').click();
  assert.deepEqual(await canvasSize(), base, 'undo restores the previous canvas');
  await page.locator('#photo-editor-redo').click();
  assert.deepEqual(await canvasSize(), rotated, 'redo re-applies the rotation');
  await page.locator('#photo-tab-draw').click();
  await page.locator('.photo-editor-swatch[data-color="#007aff"]').click();
  const drawBox = await page.locator('#photo-editor-canvas').boundingBox();
  const stroke = async (x1, y1, x2, y2) => {
    await page.mouse.move(drawBox.x + drawBox.width * x1, drawBox.y + drawBox.height * y1);
    await page.mouse.down();
    await page.mouse.move(drawBox.x + drawBox.width * x2, drawBox.y + drawBox.height * y2, {steps: 12});
    await page.mouse.up();
  };
  await stroke(0.15, 0.5, 0.85, 0.5);
  await stroke(0.5, 0.15, 0.5, 0.85);
  await page.locator('#photo-editor-apply').click();
  await page.locator('#photo-editor-overlay').waitFor({state:'hidden'});
  assert.equal(uploads.length, 3, 'rotate/draw apply must not send');
  await page.locator('#composer').evaluate(form => form.requestSubmit());
  await page.waitForFunction(n => document.querySelectorAll('#messages [data-send-state="confirmed"]').length >= n, 4);
  const drawUpload = uploads.find(item => item.name === 'lienzo-editada.jpg');
  assert.deepEqual(await imageDims(drawUpload.data, 'image/jpeg'), {width: 80, height: 120}, 'rotated upload dimensions wrong');
  const drawn = await nonRedPixels(drawUpload.data);
  assert(drawn.nonRed > drawn.total * 0.02, 'drawn stroke did not change pixels');
  await clearAttachments();

  // Cancel must leave the original bytes intact and must not send.
  await page.locator('#attachment').setInputFiles([{name:'original.png', mimeType:'image/png', buffer:red}]);
  const originalB64 = red.toString('base64');
  await openEditor();
  await page.locator('#photo-rotate-right').click();
  await page.locator('#photo-editor-cancel').click();
  await page.locator('#photo-editor-overlay').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(() => document.getElementById('photo-editor-canvas').width), 0, 'close must free the canvas bitmap');
  assert.equal((await page.locator('.composer-attachment-label').first().textContent()).includes('original.png'), true, 'cancel changed the draft file');
  await page.locator('#composer').evaluate(form => form.requestSubmit());
  await page.waitForFunction(n => document.querySelectorAll('#messages [data-send-state="confirmed"]').length >= n, 5);
  const originalUpload = uploads.find(item => item.name === 'original.png');
  assert.equal(originalUpload.mimeType, 'image/png', 'cancelled original was replaced');
  assert.equal(originalUpload.data, originalB64, 'cancelled original bytes changed');
  await clearAttachments();

  // Apply replaces only that attachment while caption + view-once + siblings hold.
  await page.locator('#attachment').setInputFiles([
    {name:'lote.png', mimeType:'image/png', buffer:red},
    {name:'otro.gif', mimeType:'image/gif', buffer:gifBuffer},
  ]);
  await page.getByRole('button', {name:'Ver una vez: lote.png'}).click();
  await page.locator('#message').fill('Leyenda del lote');
  await openEditor();
  await page.locator('#photo-rotate-right').click();
  await page.locator('#photo-editor-apply').click();
  await page.locator('#photo-editor-overlay').waitFor({state:'hidden'});
  assert.equal(await page.getByRole('button', {name:'Ver una vez: lote-editada.jpg'}).getAttribute('aria-pressed'), 'true', 'view-once lost after edit');
  await page.locator('#composer').evaluate(form => form.requestSubmit());
  await page.waitForFunction(n => document.querySelectorAll('#messages [data-send-state="confirmed"]').length >= n, 7);
  const lote = uploads.find(item => item.name === 'lote-editada.jpg');
  assert.equal(lote.viewOnce, true, 'edited upload lost view-once');
  assert.equal(lote.caption, 'Leyenda del lote', 'caption not preserved through edit');
  const gifUpload = uploads.find(item => item.name === 'otro.gif');
  assert.equal(gifUpload.mimeType, 'image/gif');
  assert.equal(gifUpload.caption, '', 'sibling attachment gained the caption');
  await clearAttachments();

  // Text tool paints glyphs onto the canvas.
  await page.locator('#attachment').setInputFiles([{name:'texto.png', mimeType:'image/png', buffer:red}]);
  await openEditor();
  await page.locator('#photo-tab-text').click();
  await page.locator('#photo-text-input').fill('HOLA');
  await page.locator('#photo-text-add').click();
  await page.locator('#photo-editor-apply').click();
  await page.locator('#photo-editor-overlay').waitFor({state:'hidden'});
  await page.locator('#composer').evaluate(form => form.requestSubmit());
  await page.waitForFunction(n => document.querySelectorAll('#messages [data-send-state="confirmed"]').length >= n, 8);
  const painted = await nonRedPixels(uploads.find(i => i.name === 'texto-editada.jpg').data);
  assert(painted.nonRed > painted.total * 0.02, 'text overlay did not paint pixels');
  await clearAttachments();

  // An oversized source is reduced to the ceiling and says so explicitly.
  await page.locator('#attachment').setInputFiles([{name:'gigante.png', mimeType:'image/png', buffer:await solidPng(5000, 3000, [10, 20, 30])}]);
  await openEditor();
  assert.equal(await page.locator('#photo-editor-notice').isVisible(), true, 'oversized edit must show the cap notice');
  const cappedSize = await canvasSize();
  assert.equal(Math.max(cappedSize.width, cappedSize.height), 4096, 'oversized image must be capped to 4096');
  assert.ok(cappedSize.width < 5000 && cappedSize.height < 3000);
  await page.locator('#photo-editor-cancel').click();
  await page.locator('#photo-editor-overlay').waitFor({state:'hidden'});
  await clearAttachments();

  // Keyboard + focus trap; Escape closes and returns focus.
  await page.locator('#attachment').setInputFiles([{name:'kb.png', mimeType:'image/png', buffer:red}]);
  await page.locator('.composer-attachment-edit').first().click();
  await page.locator('#photo-editor-overlay:not([hidden])').waitFor();
  await page.waitForFunction(() => document.querySelector('.photo-editor-stage')?.dataset.loaded === '1');
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => document.getElementById('photo-editor-overlay').contains(document.activeElement)), 'Tab escaped the editor');
  await page.keyboard.press('Escape');
  await page.locator('#photo-editor-overlay').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(() => document.activeElement.className), 'composer-attachment-edit', 'focus not restored after Escape');
  await clearAttachments();

  // Mobile 390px must fit with no horizontal overflow in both themes.
  await page.setViewportSize({width:390, height:844});
  await page.locator('#attachment').setInputFiles([{name:'movil.png', mimeType:'image/png', buffer:red}]);
  const strip = await page.evaluate(() => { const el = document.getElementById('attachment-preview'); const card = el.querySelector('.composer-media-card'); return {docScroll: document.documentElement.scrollWidth, inner: window.innerWidth, cardRight: card.getBoundingClientRect().right, editVisible: !!card.querySelector('.composer-attachment-edit')}; });
  assert(strip.editVisible, 'edit button missing from the mobile composer strip');
  assert(strip.cardRight <= strip.inner + 1, `composer strip overflows at 390px (${strip.cardRight}>${strip.inner})`);
  assert(strip.docScroll <= strip.inner + 1, `page scrolls horizontally at 390px (${strip.docScroll}>${strip.inner})`);
  for (const theme of ['dark', 'light']) {
    await page.locator('#theme').evaluate((select, value) => { select.value = value; select.dispatchEvent(new Event('change', {bubbles:true})); }, theme);
    await openEditor();
    const metrics = await page.evaluate(() => {
      const overlay = document.getElementById('photo-editor-overlay');
      const panel = overlay.querySelector('.photo-editor-panels');
      return {scroll: document.documentElement.scrollWidth, inner: window.innerWidth,
        overlayBottom: overlay.getBoundingClientRect().bottom, innerHeight: window.innerHeight,
        panelVisible: panel.getBoundingClientRect().height > 0};
    });
    assert(metrics.scroll <= metrics.inner + 1, `${theme}: horizontal overflow at 390px (${metrics.scroll}>${metrics.inner})`);
    assert(metrics.overlayBottom <= metrics.innerHeight + 1, `${theme}: editor taller than viewport`);
    assert(metrics.panelVisible, `${theme}: editor controls hidden at 390px`);
    await page.screenshot({path:path.join(outputDir, `editor-mobile-${theme}.png`), animations:'disabled'});
    await page.locator('#photo-editor-cancel').click();
    await page.locator('#photo-editor-overlay').waitFor({state:'hidden'});
  }
  // Desktop screenshots for both themes.
  await page.setViewportSize({width:1280, height:844});
  for (const theme of ['dark', 'light']) {
    await page.locator('#theme').evaluate((select, value) => { select.value = value; select.dispatchEvent(new Event('change', {bubbles:true})); }, theme);
    await openEditor();
    await page.screenshot({path:path.join(outputDir, `editor-desktop-${theme}.png`), animations:'disabled'});
    await page.locator('#photo-editor-cancel').click();
    await page.locator('#photo-editor-overlay').waitFor({state:'hidden'});
  }

  // A source photo becomes a reviewed WebP sticker; opening or applying never sends it.
  await clearAttachments();
  await page.setViewportSize({width:390, height:844});
  await page.locator('#attach').click();
  await page.getByRole('menuitem', {name:'Nuevo sticker'}).click();
  await page.getByLabel('Subir sticker').setInputFiles({name:'no-imagen.txt', mimeType:'text/plain', buffer:Buffer.from('no')});
  assert.equal(await page.locator('#photo-editor-overlay').isHidden(), true, 'a non-image must not open sticker creation');
  assert.equal(await page.getByRole('button', {name:'Enviar sticker'}).isDisabled(), true);
  await page.getByLabel('Subir sticker').setInputFiles({name:'foto-grande.png', mimeType:'image/png', buffer:Buffer.concat([red, Buffer.alloc(11 * 1024 * 1024)])});
  await page.locator('#photo-editor-overlay:not([hidden])').waitFor({state:'visible'});
  await page.locator('#photo-editor-cancel').click();
  await page.locator('#photo-editor-overlay').waitFor({state:'hidden'});
  await page.getByLabel('Subir sticker').setInputFiles({name:'sticker-origen.png', mimeType:'image/png', buffer:red});
  await page.locator('#photo-editor-overlay:not([hidden])').waitFor({state:'visible'});
  await page.waitForFunction(() => document.querySelector('.photo-editor-stage')?.dataset.loaded === '1');
  assert.equal(await page.locator('.photo-editor-header h2').textContent(), 'Crear sticker');
  assert.equal(stickerSends.length, 0);
  await page.keyboard.press('Escape');
  await page.locator('#photo-editor-overlay').waitFor({state:'hidden'});
  assert(await page.getByRole('dialog', {name:'Emoji, GIF y stickers'}).isVisible(), 'Escape should leave the picker open');
  assert.equal(await page.getByRole('button', {name:'Enviar sticker'}).isDisabled(), true);
  await page.getByLabel('Subir sticker').setInputFiles({name:'sticker-origen.png', mimeType:'image/png', buffer:red});
  await page.locator('#photo-editor-overlay:not([hidden])').waitFor({state:'visible'});
  await page.waitForFunction(() => document.querySelector('.photo-editor-stage')?.dataset.loaded === '1');
  await page.locator('#photo-tab-text').click();
  await page.locator('#photo-text-input').fill('OK');
  await page.locator('#photo-text-add').click();
  await page.locator('#photo-editor-apply').click();
  await page.locator('#photo-editor-overlay').waitFor({state:'hidden'});
  assert.equal(stickerSends.length, 0, 'applying a sticker should not send it');
  assert(await page.locator('.feature-sticker-preview img').isVisible(), 'edited sticker preview missing');
  const stickerLayout = await page.evaluate(() => ({width: window.innerWidth, scroll: document.documentElement.scrollWidth,
    dialog: document.querySelector('.feature-dialog').getBoundingClientRect().toJSON()}));
  assert(stickerLayout.scroll <= stickerLayout.width + 1, 'sticker preview overflows the phone');
  assert(stickerLayout.dialog.left >= 0 && stickerLayout.dialog.right <= stickerLayout.width + 1, 'sticker dialog escapes the phone');
  await page.screenshot({path:path.join(outputDir, 'sticker-preview-mobile.png'), animations:'disabled'});
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({width, height:700});
    const layout = await page.evaluate(() => ({width:window.innerWidth, scroll:document.documentElement.scrollWidth,
      dialog:document.querySelector('.feature-dialog').getBoundingClientRect().toJSON(),
      send:document.querySelector('.feature-sticker-preview + button').getBoundingClientRect().toJSON()}));
    assert(layout.scroll <= width + 1 && layout.dialog.left >= 0 && layout.dialog.right <= width + 1,
      `sticker dialog overflows at ${width}px`);
    assert(layout.send.left >= 0 && layout.send.right <= width + 1 && layout.send.bottom <= 701,
      `send button escapes at ${width}px`);
  }
  const stickerResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/messages/compose');
  await page.evaluate(() => { const send = [...document.querySelectorAll('button')].find(button => button.textContent === 'Enviar sticker'); send.click(); send.click(); });
  await stickerResponse;
  assert.equal(stickerSends.length, 1, 'rapid double click must send only once');
  const sticker = stickerSends[0];
  assert.equal(sticker.kind, 'sticker');
  assert.equal(sticker.mimeType, 'image/webp');
  assert.match(sticker.name, /-sticker\.webp$/);
  assert(Buffer.from(sticker.data, 'base64').length <= 100 * 1024);
  assert.deepEqual(await imageDims(sticker.data, 'image/webp'), {width:512, height:512});
  assert.deepEqual(await stickerAlpha(sticker.data), {corner:0, center:255}, 'the sticker letterbox must retain transparency');
  assert.equal(Buffer.from(sticker.data, 'base64').toString('ascii', 0, 4), 'RIFF');

  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
console.log('photo-editor.playwright: all checks passed');
