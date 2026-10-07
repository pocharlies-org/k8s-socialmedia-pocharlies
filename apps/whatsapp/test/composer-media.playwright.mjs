#!/usr/bin/env node
// Synthetic browser QA: every API response is local and camera input is fake.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(process.env.UI_SOURCE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'));
const outputDir = path.resolve(process.env.UI_OUTPUT_DIR || '/tmp/socialmedia-composer-media-qa');
const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const filename = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!filename.startsWith(`${publicDir}${path.sep}`)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(filename);
    response.writeHead(200, {'content-type': {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.woff2':'font/woff2'}[path.extname(filename)] || 'application/octet-stream'}).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless:true,
  executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome',
  args:['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']});
const origin = `http://127.0.0.1:${server.address().port}`;
const context = await browser.newContext({permissions:['camera'], baseURL:origin});
const page = await context.newPage();
const uploads = [];
const errors = [];
let failedSecond = false;
let slowRoute = null;
let slowStarted;
const slowStartedPromise = new Promise(resolve => { slowStarted = resolve; });
let nextStarted;
const nextStartedPromise = new Promise(resolve => { nextStarted = resolve; });
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.__cameraRequests = 0;
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    window.__cameraRequests++;
    const stream = await getUserMedia(constraints);
    window.__cameraTracks = stream.getTracks();
    return stream;
  };
});
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  const json = (data, status = 200) => route.fulfill({status, contentType:'application/json', body:JSON.stringify(data)});
  if (url.pathname === '/api/accounts') return json({accounts:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}], sendingEnabled:true, outboxScope:'synthetic'});
  if (url.pathname === '/api/chats') return json({chats:[{id:'one',name:'Uno'}]});
  if (url.pathname === '/api/messages') return json({messages:[], nextCursor:null});
  if (url.pathname === '/api/upload') {
    const body = route.request().postDataJSON();
    uploads.push(body);
    if (body.name === 'lento.txt') { slowRoute = route; slowStarted(); return; }
    if (body.name === 'despues.txt') nextStarted();
    if (body.name === 'segundo.txt' && !failedSecond) { failedSecond = true; return json({error:'Fallo sintetico'}, 503); }
    return json({messageId:`wa-${uploads.length}`, confirmed:true});
  }
  return json({models:[], items:[], communities:[], lists:[], favorites:[], sessions:[]});
});
try {
  await mkdir(outputDir, {recursive:true});
  await page.goto(origin);
  await page.locator('#chats .chat-item').first().click();
  assert.equal(await page.evaluate(() => window.__cameraRequests), 0);
  await page.locator('#attachment').setInputFiles([
    {name:'primera.png', mimeType:'image/png', buffer:validPng},
    {name:'segundo.txt', mimeType:'text/plain', buffer:Buffer.from('segundo')},
  ]);
  await page.locator('#message').evaluate(input => {
    const data = new DataTransfer();
    data.items.add(new File(['tercero'], 'tercero.txt', {type:'text/plain'}));
    input.dispatchEvent(new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true}));
  });
  assert.equal(await page.locator('.composer-media-card').count(), 3);
  const viewOnce = page.getByRole('button', {name:'Ver una vez: primera.png'});
  assert.equal(await page.locator('.composer-view-once').count(), 1, 'documents cannot be sent as view-once media');
  assert.equal(await viewOnce.getAttribute('aria-pressed'), 'false');
  await viewOnce.click();
  assert.equal(await viewOnce.getAttribute('aria-pressed'), 'true');
  await page.locator('#message').fill('Leyenda');
  await page.locator('#attachment-thumbnail').evaluate(image => image.decode());
  assert((await page.locator('#attachment-thumbnail').evaluate(image => image.naturalWidth)) > 0);
  await page.screenshot({path:path.join(outputDir, 'composer-staging-desktop-dark.png'), animations:'disabled'});
  await page.locator('#theme').evaluate(select => { select.value = 'light'; select.dispatchEvent(new Event('change', {bubbles:true})); });
  await page.screenshot({path:path.join(outputDir, 'composer-staging-desktop-light.png'), animations:'disabled'});
  await page.setViewportSize({width:390, height:844});
  await page.screenshot({path:path.join(outputDir, 'composer-staging-mobile-light.png'), animations:'disabled'});
  await page.setViewportSize({width:1280, height:720});
  await page.locator('#theme').evaluate(select => { select.value = 'dark'; select.dispatchEvent(new Event('change', {bubbles:true})); });
  assert.equal(uploads.length, 0);
  await page.locator('#composer').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => document.querySelectorAll('#messages [data-send-state="failed"]').length === 1);
  await page.waitForFunction(() => document.querySelectorAll('#messages [data-send-state="confirmed"]').length === 2);
  assert.deepEqual(uploads.map(item => [item.name, item.caption]), [
    ['primera.png', 'Leyenda'], ['segundo.txt', ''], ['tercero.txt', ''],
  ]);
  assert.equal(uploads[0].viewOnce, true);
  assert.equal(uploads.slice(1).every(item => !Object.hasOwn(item, 'viewOnce')), true);
  assert.equal(new Set(uploads.map(item => item.sendToken)).size, 3);
  const failedToken = uploads[1].sendToken;
  await page.getByRole('button', {name:'Reintentar el mismo envío'}).click();
  await page.waitForFunction(() => document.querySelectorAll('#messages [data-send-state="confirmed"]').length === 3);
  assert.equal(uploads.length, 4);
  await page.waitForFunction(() => document.querySelectorAll('#messages [data-send-state="failed"]').length === 0);
  assert.equal(uploads.at(-1).sendToken, failedToken);

  await page.locator('#attach').click();
  for (const theme of ['dark', 'light']) {
    await page.locator('#theme').evaluate((select, value) => { select.value = value; select.dispatchEvent(new Event('change', {bubbles:true})); }, theme);
    const ratio = await page.locator('#feature-attach-menu').evaluate(menu => {
      const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
        const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const bg = luminance(getComputedStyle(menu).backgroundColor);
      const fg = luminance(getComputedStyle(menu.querySelector('button')).color);
      return (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05);
    });
    assert(ratio >= 4.5, `${theme}: attachment menu text contrast is too low`);
    assert.equal(await page.locator('#feature-attach-menu .camera').evaluate(icon => getComputedStyle(icon).color === 'rgb(255, 255, 255)'), false);
    await page.locator('#feature-attach-menu').screenshot({path:path.join(outputDir, `attachment-menu-${theme}.png`)});
  }
  await page.getByRole('menuitem', {name:'Cámara'}).click();
  await page.locator('#camera-capture').waitFor({state:'visible'});
  await page.waitForFunction(() => !document.querySelector('#camera-capture').disabled);
  assert.equal(await page.evaluate(() => window.__cameraRequests), 1);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'camera-capture');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'camera-cancel');
  const beforeCapture = uploads.length;
  await page.locator('#camera-capture').click();
  await page.waitForFunction(() => document.querySelector('#camera-overlay').hidden);
  assert.equal(await page.locator('.composer-media-card').count(), 1);
  assert.equal(uploads.length, beforeCapture, 'capturing a photo sent it without Send');
  assert.deepEqual(await page.evaluate(() => window.__cameraTracks.map(track => track.readyState)), ['ended']);
  await page.locator('#attachment-remove').click();
  await page.locator('#attach').click();
  await page.getByRole('menuitem', {name:'Cámara'}).click();
  await page.waitForFunction(() => !document.querySelector('#camera-capture').disabled);
  await page.locator('#camera-cancel').click();
  assert.deepEqual(await page.evaluate(() => window.__cameraTracks.map(track => track.readyState)), ['ended']);
  assert.equal(uploads.length, beforeCapture);
  await page.locator('#attach').click();
  await page.getByRole('menuitem', {name:'Nuevo sticker'}).click();
  await page.locator('.feature-picker-content input[accept="image/webp"]').waitFor();
  assert.equal(await page.getByRole('button', {name:'Enviar sticker'}).isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(uploads.length, beforeCapture);
  await page.locator('.conversation').evaluate(zone => {
    const data = new DataTransfer();
    data.items.add(new File(['soltado'], 'soltado.txt', {type:'text/plain'}));
    zone.dispatchEvent(new DragEvent('drop', {dataTransfer:data, bubbles:true, cancelable:true}));
  });
  assert.equal(await page.locator('.composer-media-card').count(), 1);
  await page.locator('#attachment-remove').click();
  await page.locator('#attachment').setInputFiles([
    {name:'lento.txt', mimeType:'text/plain', buffer:Buffer.from('lento')},
    {name:'despues.txt', mimeType:'text/plain', buffer:Buffer.from('despues')},
  ]);
  await page.locator('#composer').evaluate(form => form.requestSubmit());
  await slowStartedPromise;
  await page.locator('#message').fill('Borrador nuevo');
  assert.equal(await page.locator('#message').inputValue(), 'Borrador nuevo');
  await page.locator('#account').evaluate(select => {
    select.value = 'beta';
    select.dispatchEvent(new Event('change', {bubbles:true}));
  });
  await page.waitForFunction(() => document.querySelector('#account').value === 'beta');
  await slowRoute.fulfill({status:200, contentType:'application/json', body:JSON.stringify({messageId:'wa-lento', confirmed:true})});
  await nextStartedPromise;
  assert.equal(await page.locator('.composer-media-card').count(), 0, 'account switch retained another account draft');
  await page.locator('#account').evaluate(select => {
    select.value = 'alpha';
    select.dispatchEvent(new Event('change', {bubbles:true}));
  });
  await page.locator('#chats .chat-item').first().click();
  assert.equal(await page.locator('#message').inputValue(), 'Borrador nuevo');
  assert.deepEqual(uploads.filter(item => ['lento.txt', 'despues.txt'].includes(item.name)).map(item => [item.account, item.chat]),
    [['alpha', 'one'], ['alpha', 'one']], 'authorized batch changed destination after account switch');
  assert.deepEqual(errors, []);
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
