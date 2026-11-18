import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import {dirname, extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const root = fileURLToPath(new URL('../public/', import.meta.url));
const streams = new Map([['personal', new Set()], ['secondary', new Set()]]);
const caption = 'Foto saliente de fixture: adjunto recuperado';
const messageId = '11111111-1111-4111-8111-111111111111';
const attachmentId = '22222222-2222-4222-8222-222222222222';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNa0AAAAASUVORK5CYII=', 'base64');
let attached = false;
let sends = 0;
let mediaReads = 0;
const types = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2'};
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const account = url.searchParams.get('account') || 'personal';
  if (request.method !== 'GET') {
    // Opening a chat marks it read; only delivery endpoints indicate a new send.
    if (['/api/send', '/api/upload', '/api/messages/reply', '/api/messages/compose', '/api/compose', '/api/share', '/api/ai/chat'].includes(url.pathname)) sends += 1;
    response.writeHead(200, {'content-type':'application/json'}).end('{}');
    return;
  }
  if (url.pathname === '/api/events') {
    response.writeHead(200, {'content-type':'text/event-stream', 'cache-control':'no-cache'});
    response.write(': connected\n\n');
    streams.get(account)?.add(response);
    response.on('close', () => streams.get(account)?.delete(response));
    return;
  }
  if (url.pathname === `/api/media/${attachmentId}`) {
    if (account !== 'personal' || url.searchParams.get('chat') !== 'personal-chat' || !attached) {
      response.writeHead(404).end();
      return;
    }
    mediaReads += 1;
    response.writeHead(200, {'content-type':'image/png', 'content-length':png.length}).end(png);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    let data = {};
    if (url.pathname === '/api/accounts') data = {accounts:[{id:'personal',label:'Personal'},{id:'secondary',label:'Secundaria'}], sendingEnabled:true};
    if (url.pathname === '/api/chats') data = {chats:[{id:`${account}-chat`,name:account === 'personal' ? 'Comando Benitez (fixture)' : 'Chat secundario (fixture)',preview:account === 'personal' ? caption : 'Solo secundaria',unread:0}]};
    if (url.pathname === '/api/messages') data = {messages:account === 'personal' ? [{
      id:messageId, waMessageId:'fixture-outgoing-image', fromMe:true, type:'IMAGE', text:caption,
      timestamp:'2026-10-11T10:00:00Z', deliveryStatus:'sent',
      attachments:attached ? [{id:attachmentId, type:'IMAGE', mimeType:'image/png', name:'fixture.png', size:png.length,
        caption, url:`/api/media/${attachmentId}?account=personal&chat=personal-chat`}] : [],
    }] : [{id:'secondary-message', text:'Solo secundaria', timestamp:'2026-10-11T10:00:00Z'}]};
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
// An ephemeral loopback port keeps this fixture isolated from running services.
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless:true, args:['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
const context = await browser.newContext({viewport:{width:1280,height:900}});
const personal = await context.newPage();
const secondary = await context.newPage();
const errors = [];
for (const page of [personal, secondary]) page.on('pageerror', error => errors.push(error.message));
const origin = `http://127.0.0.1:${server.address().port}`;
const emit = account => {
  for (const stream of streams.get(account) || []) stream.write(`event: message\ndata: ${JSON.stringify({account, conversation_id:`${account}-chat`, message_id:messageId, reason:'attachment'})}\n\n`);
};
try {
  await personal.goto(origin);
  await personal.locator('#chats .chat-item').first().click();
  await personal.locator('#messages .message-text').getByText(caption, {exact:true}).waitFor();
  assert.equal(await personal.locator('#messages .attachment-image').count(), 0);
  assert.equal(await personal.locator('#messages .message').count(), 1);
  // Retain a reference to the document, so a reload cannot satisfy the oracle.
  await personal.evaluate(() => { window.fixtureDocument = document; });
  await secondary.goto(origin);
  await secondary.getByRole('button', {name:'Cuenta de WhatsApp: Secundaria'}).click();
  await secondary.locator('#chats .chat-item').first().click();
  await secondary.locator('#messages .message-text').getByText('Solo secundaria', {exact:true}).waitFor();
  assert(streams.get('personal').size && streams.get('secondary').size, 'both accounts must have active SSE streams');

  attached = true;
  emit('personal');
  await personal.waitForFunction(() => {
    const image = document.querySelector('#messages .attachment-image');
    return image?.complete && image.naturalWidth > 0;
  }, null, {timeout:5000});
  assert.equal(await personal.evaluate(() => window.fixtureDocument === document), true, 'image must appear without a page reload');
  assert.equal(await personal.locator(`#messages .message[data-message-id="${messageId}"]`).count(), 1);
  assert.equal(await personal.locator('#messages .message').count(), 1, 'the attachment must update the existing bubble');
  assert.equal(await personal.locator('#messages .message-text').getByText(caption, {exact:true}).count(), 1);
  assert.equal(await personal.locator('#messages .attachment-caption').count(), 0, 'caption must not be duplicated');
  assert(mediaReads > 0, 'the browser must fetch and decode the real PNG endpoint');
  const secondaryRefresh = secondary.waitForResponse(response => response.url().includes('/api/messages?') && response.url().includes('account=secondary'));
  emit('secondary');
  await secondaryRefresh;
  assert.equal(await secondary.locator('#messages .message-text').getByText(caption, {exact:true}).count(), 0);
  assert.equal(await secondary.locator('#messages .attachment-image').count(), 0);
  const denied = await context.request.get(`${origin}/api/media/${attachmentId}?account=secondary&chat=secondary-chat`);
  assert.equal(denied.status(), 404, 'secondary cannot read the personal fixture media');
  assert.equal(sends, 0, 'the scenario must not send a new message');
  assert.deepEqual(errors, []);
  if (process.env.PLAYWRIGHT_SCREENSHOT_PATH) {
    await mkdir(dirname(process.env.PLAYWRIGHT_SCREENSHOT_PATH), {recursive:true});
    await personal.screenshot({path:process.env.PLAYWRIGHT_SCREENSHOT_PATH, fullPage:true});
  }
  console.log('PASS fixture: outgoing image attachment refreshes via SSE, one bubble/caption, no reload/send, account isolation');
} finally {
  await context.close();
  await browser.close();
  for (const group of streams.values()) for (const stream of group) stream.end();
  await new Promise(resolve => server.close(resolve));
}
