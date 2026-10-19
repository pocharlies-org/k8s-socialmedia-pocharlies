#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const server = createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname;
  const filename = path.resolve(publicDir, `.${name === '/' ? '/index.html' : name}`);
  if (!filename.startsWith(`${publicDir}${path.sep}`)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(filename);
    response.writeHead(200, {'content-type': {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.woff2':'font/woff2'}[path.extname(filename)] || 'application/octet-stream'}).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome'});
const messages = [];
let sendRoute;
await (async () => {
  const page = await browser.newPage();
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const json = body => route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(body)});
    if (url.pathname === '/api/accounts') return json({accounts:[{id:'alpha', label:'Alpha'}], sendingEnabled:true, outboxScope:'early-echo'});
    if (url.pathname === '/api/chats') return json({chats:[{id:'one', name:'Uno'}]});
    if (url.pathname === '/api/messages') return json({messages});
    if (url.pathname === '/api/models') return json({models:[]});
    if (url.pathname === '/api/ai/sessions') return json({sessions:[]});
    if (url.pathname === '/api/send') { sendRoute = route; return; }
    return json({});
  });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('.chat-item').first().click();
    await page.locator('#message').fill('eco temprano');
    await page.locator('#message').press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-send-state="sending"]'));
    messages.push({id:'db-echo', waMessageId:'wa-echo', text:'eco temprano', fromMe:true, timestamp:new Date().toISOString()});
    await page.locator('.chat-item').first().click();
    await page.waitForFunction(() => document.querySelector('[data-message-id="db-echo"]'));
    assert.equal(await page.locator('#messages .message-text').filter({hasText:'eco temprano'}).count(), 1);
    assert.equal(await page.locator('[data-send-state="sending"]').count(), 0);
    await sendRoute.fulfill({status:200, contentType:'application/json', body:JSON.stringify({messageId:'wa-echo'})});
    await page.waitForFunction(() => !document.querySelector('[data-send-state]'));
    assert.equal(await page.locator('#messages .message-text').filter({hasText:'eco temprano'}).count(), 1);
    console.log('Early echo browser QA passed');
  } finally { await page.close(); }
})().finally(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
