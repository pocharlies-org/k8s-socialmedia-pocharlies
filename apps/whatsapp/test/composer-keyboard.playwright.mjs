#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(process.env.UI_SOURCE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'));
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const filename = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!filename.startsWith(`${publicDir}${path.sep}`)) return response.writeHead(403).end();
  try {
    const body = await readFile(filename);
    response.writeHead(200, {'content-type': {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.woff2':'font/woff2'}[path.extname(filename)] || 'application/octet-stream'}).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome'});
const context = await browser.newContext({viewport:{width:390,height:844}, hasTouch:true, isMobile:true});
const page = await context.newPage();
const sends = [];
const uploads = [];
const hermesTurns = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  const body = request.method() === 'POST' ? request.postDataJSON() : null;
  const json = payload => route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(payload)});
  if (url.pathname === '/api/accounts') return json({accounts:[{id:'alpha',label:'Alpha'}], sendingEnabled:true, outboxScope:'composer-keyboard'});
  if (url.pathname === '/api/chats') return json({chats:[{id:'one',name:'Uno'}]});
  if (url.pathname === '/api/messages') return json({messages:[]});
  if (url.pathname === '/api/send') { sends.push(body); return json({messageId:`wa-${sends.length}`}); }
  if (url.pathname === '/api/upload') { uploads.push(body); return json({messageId:`wa-file-${uploads.length}`}); }
  if (url.pathname === '/api/ai/session') return json({sessionId:'hermes-session',messages:[]});
  if (url.pathname === '/api/ai/proposals') return json({proposals:[]});
  if (url.pathname === '/api/ai/chat') { hermesTurns.push(body); return json({sessionId:'hermes-session',text:'Respuesta de Hermes'}); }
  return json({});
});

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#chats .chat-item').first().click();
  const message = page.locator('#message');
  assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true, 'test must exercise a touch-style pointer');
  assert.equal(await message.getAttribute('placeholder'), 'Escribe un mensaje');
  assert.match(await message.getAttribute('title'), /Enter para enviar.*Shift\+Enter/);
  assert.match(await message.getAttribute('aria-description'), /Enter para enviar.*Shift\+Enter/);
  assert.equal(await message.evaluate(element => element.enterKeyHint), 'send');
  await page.setViewportSize({width:1280,height:844});
  await page.waitForFunction(() => document.querySelector('#message')?.placeholder.includes('Enter para enviar'));
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(() => document.querySelector('#message')?.placeholder === 'Escribe un mensaje');

  for (const options of [
    {key:'Enter', isComposing:true},
    {key:'Enter', keyCode:229, which:229},
  ]) {
    await message.fill('texto en composición');
    await message.evaluate((element, init) => element.dispatchEvent(new KeyboardEvent('keydown', {...init, bubbles:true, cancelable:true})), options);
    assert.equal(await message.inputValue(), 'texto en composición', 'IME confirmation must leave the composing text untouched');
    assert.equal(sends.length, 0, 'IME confirmation must not send');
  }

  await message.fill('primera línea');
  await message.press('Shift+Enter');
  await message.type('segunda línea');
  assert.equal(await message.inputValue(), 'primera línea\nsegunda línea');
  assert.equal(sends.length, 0, 'Shift+Enter should insert a line without sending');
  await message.press('Enter');
  await page.waitForFunction(() => document.querySelector('#message').value === '');
  assert.equal(sends[0].text, 'primera línea\nsegunda línea', 'Enter should send the complete multiline text');

  const longText = 'mensaje largo '.repeat(600);
  await message.fill(longText);
  await message.press('Enter');
  await page.waitForFunction(() => document.querySelector('#message').value === '');
  assert.equal(sends[1].text, longText.trim(), 'Enter should preserve long messages');

  await page.locator('#attachment').setInputFiles({name:'nota.txt', mimeType:'text/plain', buffer:Buffer.from('contenido')});
  await page.locator('.composer-media-card').waitFor();
  const uploadResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/upload');
  await message.press('Enter');
  await uploadResponse;
  await page.waitForFunction(() => document.querySelector('#attachment-preview').hidden && !document.querySelector('.composer-media-card'));
  assert.equal(uploads.length, 1, 'Enter should submit staged attachments');
  assert.equal(uploads[0].name, 'nota.txt');

  await page.setViewportSize({width:1280,height:844});
  await page.waitForFunction(() => document.querySelector('#message')?.placeholder.includes('Enter para enviar'));
  await page.locator('.rail-settings summary').click();
  await page.locator('#settings-enter-send').uncheck();
  assert.match(await message.getAttribute('placeholder'), /Ctrl\/Cmd\+Enter para enviar.*Enter para nueva línea/);
  assert.match(await message.getAttribute('title'), /Ctrl\/Cmd\+Enter para enviar.*Enter para nueva línea/);
  assert.equal(await message.evaluate(element => element.enterKeyHint), 'enter');
  await page.locator('#settings-close').click();
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(() => document.querySelector('#message')?.placeholder === 'Escribe un mensaje');
  await message.fill('preferencia conservada');
  await message.press('Enter');
  assert.equal(await message.inputValue(), 'preferencia conservada\n', 'disabling Enter-to-send should retain the existing newline behavior');
  await message.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#message').value === '');
  assert.equal(sends[2].text, 'preferencia conservada', 'the existing Ctrl/Cmd+Enter preference should keep working');

  await page.locator('#ai-toggle').click();
  const hermesInput = page.locator('#ai-prompt');
  await hermesInput.waitFor({state:'visible'});
  await hermesInput.fill('consulta para Hermes');
  await hermesInput.press('Enter');
  await page.waitForFunction(() => document.querySelector('.ai-bubble-out'));
  assert.equal(hermesTurns.length, 1, 'the Hermes composer should keep its own Enter-to-send behavior');
  assert.equal(hermesTurns[0].message, 'consulta para Hermes');
  assert.deepEqual(errors, []);
  console.log('Composer keyboard browser QA passed');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
