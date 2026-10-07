import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const root = fileURLToPath(new URL('../public/', import.meta.url));
const streams = new Map([['personal', new Set()], ['secondary', new Set()]]);
const messages = new Map([['personal', ['Inicial personal']], ['secondary', ['Inicial secundaria']]]);
const reads = new Map([['personal', 0], ['secondary', 0]]);
const types = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2'};
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const account = url.searchParams.get('account') || 'personal';
  if (url.pathname === '/api/events') {
    response.writeHead(200, {'content-type':'text/event-stream', 'cache-control':'no-cache', 'x-accel-buffering':'no'});
    response.write(': connected\n\n');
    streams.get(account)?.add(response);
    response.on('close', () => streams.get(account)?.delete(response));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    let data = {};
    if (url.pathname === '/api/accounts') data = {accounts:[{id:'personal',label:'Personal'},{id:'secondary',label:'Secundaria'}], sendingEnabled:true};
    if (url.pathname === '/api/chats') data = {chats:[{id:`${account}-chat`,name:account === 'personal' ? 'Ana' : 'Bruno',preview:messages.get(account)?.at(-1),unread:0}]};
    if (url.pathname === '/api/messages') {
      reads.set(account, (reads.get(account) || 0) + 1);
      data = {messages:(messages.get(account) || []).map((text, index) => ({id:`${account}-${index}`,text,timestamp:new Date(2026,8,29,12,index).toISOString()}))};
    }
    response.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify(data));
    return;
  }
  try {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (file.includes('..')) throw Error('Invalid path');
    const body = await readFile(join(root, file));
    response.writeHead(200, {'content-type':types[extname(file)] || 'application/octet-stream'}).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({headless:true, args:['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const origin = `http://127.0.0.1:${server.address().port}`;
const emit = (account, type = 'message') => {
  for (const stream of streams.get(account) || []) stream.write(`event: ${type}\ndata: ${JSON.stringify({account, conversation_id:`${account}-chat`})}\n\n`);
};
const waitForStream = async account => {
  for (let attempt = 0; attempt < 50 && !streams.get(account)?.size; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert(streams.get(account)?.size, `No SSE stream for ${account}`);
};
try {
  await page.goto(origin);
  await page.locator('#chats .chat-item').first().click();
  await page.locator('#messages .message-text').getByText('Inicial personal', {exact:true}).waitFor();
  await waitForStream('personal');
  await page.waitForTimeout(350); // Let the initial SSE resync settle.
  const beforeBurst = reads.get('personal');
  messages.get('personal').push('Recibido en directo');
  emit('personal'); emit('personal'); emit('personal', 'chat');
  await page.locator('#messages .message-text').getByText('Recibido en directo', {exact:true}).waitFor({timeout:3000});
  assert.equal(reads.get('personal'), beforeBurst + 1, 'one event burst should make one message request');

  await page.getByRole('button', {name:'Cuenta de WhatsApp: Secundaria'}).click();
  await page.locator('#chats .chat-item').first().click();
  await page.locator('#messages .message-text').getByText('Inicial secundaria', {exact:true}).waitFor();
  await waitForStream('secondary');
  messages.get('personal').push('Solo personal');
  emit('personal');
  messages.get('secondary').push('Solo secundaria');
  emit('secondary');
  await page.locator('#messages .message-text').getByText('Solo secundaria', {exact:true}).waitFor({timeout:3000});
  assert.equal(await page.locator('#messages .message-text').getByText('Solo personal', {exact:true}).count(), 0, 'account data must stay isolated');
  assert.deepEqual(pageErrors, []);
  console.log('PASS live updates: account-scoped SSE, burst coalescing and browser rendering');
} finally {
  await page.close();
  await browser.close();
  for (const group of streams.values()) for (const stream of group) stream.end();
  await new Promise(resolve => server.close(resolve));
}
