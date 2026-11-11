#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(process.env.UI_SOURCE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../public'));
const artifactDir = path.resolve(process.env.PLAYWRIGHT_ARTIFACT_DIR || '/tmp/whatsapp-history-recovery-qa');
await mkdir(artifactDir, {recursive:true});
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const filename = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!filename.startsWith(`${publicDir}${path.sep}`)) return response.writeHead(403).end();
  try {
    const body = await readFile(filename);
    response.writeHead(200, {'content-type': {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml'}[path.extname(filename)] || 'application/octet-stream'}).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome'});
const context = await browser.newContext({viewport:{width:1280,height:900}, serviceWorkers:'block'});
await context.tracing.start({screenshots:true, snapshots:true, sources:true});
const page = await context.newPage();
await page.clock.install();
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const chats = ['empty', 'placeholder', 'populated', 'business', 'delayed-chat', 'delayed-account'].map(id => ({id, name:`Fixture ${id}`}));
const message = (id, text) => ({id, text, type:'TEXT', timestamp:'2026-10-09T12:00:00Z', fromMe:false, attachments:[]});
const calls = [];
const gets = [];
const held = new Map();
const count = key => calls.filter(call => `${call.account}:${call.chat}` === key).length;
await page.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== origin) return route.abort();
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const json = (payload, status = 200) => route.fulfill({status, contentType:'application/json', body:JSON.stringify(payload)});
  if (url.pathname === '/api/accounts') return json({accounts:[{id:'alpha',label:'Alpha'}, {id:'beta',label:'Beta'}], sendingEnabled:false, outboxScope:'history-recovery'});
  if (url.pathname === '/api/chats') return json({chats});
  if (url.pathname === '/api/messages') {
    const key = `${url.searchParams.get('account')}:${url.searchParams.get('chat')}`;
    gets.push(key);
    const chat = url.searchParams.get('chat');
    return json({messages:chat === 'populated' ? [message('existing', 'Existing populated content')] : chat === 'business' ? [
      {...message('appointment', 'Tu cita es el jueves a las 10:00.\nClinica de ejemplo\nCONFIRMAR\nNO'), type:'TEMPLATEMESSAGE'},
      {...message('confirm', 'CONFIRMAR'), fromMe:true, type:'TEMPLATEBUTTONREPLYMESSAGE', replyToMessageId:'appointment',
        replyPreview:{available:true, type:'TEMPLATEMESSAGE', text:'Tu cita es el jueves a las 10:00. Clinica de ejemplo', senderName:'Clinica de ejemplo'}},
    ] : chat === 'placeholder' ? [message('placeholder', '')] : []});
  }
  if (url.pathname === '/api/messages/recover') {
    assert.equal(request.method(), 'POST');
    const body = request.postDataJSON();
    calls.push(body);
    const key = `${body.account}:${body.chat}`;
    if (body.chat.startsWith('delayed') || (body.chat === 'empty' && count(key) === 1)) {
      return new Promise(resolve => held.set(key, async payload => { await json(payload); resolve(); }));
    }
    if (body.chat === 'placeholder') return json({error:'Fixture failure'}, 503);
    return json({status:'requested', recovered:0});
  }
  if (url.pathname === '/api/ai/session') return json({messages:[]});
  if (url.pathname === '/api/ai/proposals') return json({proposals:[]});
  return json({});
});

const select = async chat => {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/messages' && new URL(response.url()).searchParams.get('chat') === chat);
  await page.locator('#chats .chat-item').filter({hasText:`Fixture ${chat}`}).click();
  await response;
  await page.evaluate(() => loadMessages());
};
const label = text => page.getByText(text, {exact:true});
const pending = 'Recuperando mensajes…';
const failed = 'No se pudo solicitar el historial. Puedes volver a intentarlo.';
const noAnchor = 'WhatsApp aún no ha facilitado el historial de este chat. Comprueba que tu teléfono esté conectado.';
const requested = 'Historial solicitado al teléfono. Esperando a WhatsApp…';
try {
  await page.goto(origin);
  await select('populated');
  await label('Existing populated content').waitFor();
  assert.equal(calls.length, 0, 'populated chats must not trigger recovery');
  await select('business');
  await page.locator('.message-reply-reference').filter({hasText:'Clinica de ejemplo'}).waitFor();
  assert.match(await page.locator('#messages').innerText(), /Tu cita es el jueves/);
  assert.doesNotMatch(await page.locator('#messages').innerText(), /@lid|Mensaje no disponible/);
  assert.equal(calls.length, 0, 'captured business content must not trigger phone recovery');
  await page.screenshot({path:path.join(artifactDir, 'business-messages.png'), fullPage:true});

  await select('empty');
  await label(pending).waitFor();
  assert.equal(count('alpha:empty'), 1, 'empty chat triggers exactly one automatic recovery across refreshes');
  await held.get('alpha:empty')({status:'no_anchor', recovered:0});
  await label(noAnchor).waitFor();
  await select('populated');
  await select('empty');
  await label(noAnchor).waitFor();
  assert.equal(count('alpha:empty'), 1, 'reselecting an empty chat must not repeat recovery');
  await page.getByRole('button', {name:'Reintentar', exact:true}).click();
  await label(requested).waitFor();
  assert.equal(count('alpha:empty'), 2, 'explicit retry must issue a second request');
  await page.clock.fastForward(31000);
  await label('WhatsApp no ha entregado nuevos mensajes durante la espera. El contenido no disponible sigue pendiente; puedes reintentar.').waitFor();
  assert.equal(count('alpha:empty'), 2, 'timeout must not repeat phone recovery automatically');
  await page.getByRole('button', {name:'Reintentar', exact:true}).waitFor();

  await select('placeholder');
  await label(failed).waitFor();
  assert.equal(count('alpha:placeholder'), 1, 'placeholder messages trigger automatic recovery');
  const failedRetry = page.waitForResponse('**/api/messages/recover');
  await page.getByRole('button', {name:'Reintentar', exact:true}).click();
  await failedRetry;
  await label(failed).waitFor();
  await page.evaluate(() => loadMessages());
  assert.equal(count('alpha:placeholder'), 2, 'failed retries must not cause an automatic loop');

  await select('delayed-chat');
  await label(pending).waitFor();
  await select('populated');
  const populatedGets = gets.filter(key => key === 'alpha:populated').length;
  const delayedResponse = page.waitForResponse('**/api/messages/recover');
  await held.get('alpha:delayed-chat')({status:'recovered', recovered:3});
  await delayedResponse;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await label('Existing populated content').waitFor();
  assert.equal(await label('Mensajes recuperados.').isVisible(), false, 'old chat status must not leak');
  assert.equal(gets.filter(key => key === 'alpha:populated').length, populatedGets, 'old recovery must not reload the newly selected chat');

  await select('delayed-account');
  await label(pending).waitFor();
  const betaChats = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chats' && new URL(response.url()).searchParams.get('account') === 'beta');
  await page.getByRole('button', {name:'Cuenta de WhatsApp: Beta', exact:true}).click();
  await betaChats;
  await select('populated');
  const betaGets = gets.filter(key => key === 'beta:populated').length;
  const accountResponse = page.waitForResponse('**/api/messages/recover');
  await held.get('alpha:delayed-account')({status:'failed', recovered:3});
  await accountResponse;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await label('Existing populated content').waitFor();
  assert.equal(await label(failed).isVisible(), false, 'old account status must not leak');
  assert.equal(gets.filter(key => key === 'beta:populated').length, betaGets, 'old account recovery must not reload current messages');

  await select('empty');
  await label(pending).waitFor();
  assert.equal(count('beta:empty'), 1, 'same chat in another account has its own automatic recovery');
  await held.get('beta:empty')({status:'no_anchor', recovered:0});
  await label(noAnchor).waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({path:path.join(artifactDir, 'history-recovery.png'), fullPage:true});
  console.log(`History recovery browser QA passed (${calls.length} mocked recovery requests); artifacts: ${artifactDir}`);
} catch (error) {
  await page.screenshot({path:path.join(artifactDir, 'failure.png'), fullPage:true});
  throw error;
} finally {
  await context.tracing.stop({path:path.join(artifactDir, 'trace.zip')});
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
