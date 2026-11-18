import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const html = `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body data-theme="light"><main id="messages" style="padding:24px;max-width:600px"></main><script type="module">
import {renderMessage} from '/message-render.mjs';
import {installEventUI} from '/event-ui.mjs';
window.ctx={account:'alpha',chat:'123@g.us',version:1};
window.allowSend=true;
window.draw=(metadata={})=>document.querySelector('#messages').replaceChildren(renderMessage({id:'event-id',text:'Encuentro',fromMe:false,metadata:{kind:'event',extraGuestsAllowed:true,startTime:1790600000,...metadata}}));
draw();
installEventUI({container:document.querySelector('#messages'),getContext:()=>ctx,canSend:()=>allowSend,api:async(url,body)=>{
 const response=await fetch(url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
 if(!response.ok)throw new Error('fixture');return response.json();
}});window.ready=true;
</script></body></html>`;
const server = createServer(async (req, res) => {
  if (req.url === '/') {res.writeHead(200, {'content-type':'text/html'}).end(html); return;}
  const file = path.resolve(publicDir, `.${new URL(req.url, 'http://fixture').pathname}`);
  if (!file.startsWith(publicDir + path.sep)) {res.writeHead(403).end(); return;}
  try {res.writeHead(200, {'content-type':file.endsWith('.css')?'text/css':'text/javascript'}).end(await readFile(file));}
  catch {res.writeHead(404).end();}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome',args:['--no-sandbox']});
try {
  const page = await browser.newPage({viewport:{width:800,height:600}});
  const errors = [];
  const sends = [];
  const resultCalls = {count: 0};
  let releaseSend;
  let notifyHeldSend;
  const heldSend = () => new Promise(resolve => {notifyHeldSend = resolve;});
  let failSend = false;
  let holdSend = false;
  let resultsAvailable = true;
  let selectedByMe = 'going';
  let selectedExtraGuestCount = 2;
  await page.route('**/api/messages/event/results?**', async route => {
    resultCalls.count += 1;
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({json:{account:params.get('account'),chat:params.get('chat'),results:{available:resultsAvailable,counts:{going:2,not_going:1,maybe:0},selectedByMe,selectedExtraGuestCount}}});
  });
  await page.route('**/api/messages/event/respond', async route => {
    const body = route.request().postDataJSON(); sends.push(body);
    if (holdSend) await new Promise(resolve => {releaseSend=resolve;notifyHeldSend?.();notifyHeldSend=null;});
    await route.fulfill({status:failSend?503:200,json:{confirmed:true,account:body.account,chat:body.chat,messageId:'reply'}});
  });
  page.on('pageerror', error => errors.push(error.message));
  const statusText = () => page.locator('.event-response-status').textContent();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.ready);
  await page.getByRole('button',{name:'Ver respuestas'}).click();
  await page.getByRole('button',{name:'Asistiré',exact:true}).waitFor();
  assert.equal(await page.getByRole('spinbutton',{name:'Acompañantes'}).inputValue(),'2');
  assert.equal(sends.length,0);
  holdSend=true;
  const firstHeld=heldSend();
  await page.getByRole('button',{name:'Asistiré',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.event-response-status').textContent === 'Enviando respuesta…');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('socialmedia:event-rsvp-unresolved:v1')).length),1,'in-flight send has a recovery marker');
  assert.equal(await page.getByRole('button',{name:'Quizá',exact:true}).isDisabled(),true);
  await firstHeld;releaseSend(); holdSend=false;
  await page.waitForFunction(() => document.querySelector('.event-response-status').textContent === 'Respuesta enviada');
  assert.equal(sends.length,1);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('socialmedia:event-rsvp-unresolved:v1')).length),0,'confirmed send clears its recovery marker');
  assert.equal(await page.getByRole('button',{name:'Asistiré',exact:true}).getAttribute('aria-pressed'),'true');
  // An unconfirmed send refreshes results and requires a deliberate resend.
  const resultsBeforeFailure = resultCalls.count;
  failSend=true;
  await page.getByRole('button',{name:'Quizá',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.event-response-status').textContent === 'No se pudo confirmar la entrega anterior.');
  assert.equal(sends.length,2,'only the failed attempt is sent while unconfirmed');
  assert.ok(resultCalls.count > resultsBeforeFailure,'results must be refreshed to check the selected response');
  const failedToken=sends.at(-1).sendToken;
  await page.waitForTimeout(250);
  assert.equal(sends.length,2,'an unconfirmed outcome must not trigger an automatic replay');
  const retry = page.getByRole('button',{name:'Enviar de nuevo',exact:true});
  await retry.waitFor();
  assert.equal(await retry.isEnabled(),true);
  assert.equal(await page.getByRole('button',{name:'Quizá',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Actualizar respuestas'}).isDisabled(),true);
  assert.match((await page.locator('.event-response-panel').textContent()) || '',/sin confirmar/);
  await page.evaluate(() => draw());
  await page.getByRole('button',{name:'Ver respuestas'}).click();
  await page.getByRole('button',{name:'Enviar de nuevo',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Quizá',exact:true}).isDisabled(),true,'redraw must retain the uncertain outcome');
  assert.equal(sends.length,2,'redraw must not replay the send');
  await page.reload();
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {ctx={account:'beta',chat:'999@g.us',version:2};draw();});
  await page.getByRole('button',{name:'Ver respuestas'}).click();
  await page.getByRole('button',{name:'Quizá',exact:true}).waitFor();
  assert.equal(await page.locator('.event-response-retry').count(),0,'another account has no pending RSVP');
  await page.evaluate(() => {ctx={account:'alpha',chat:'123@g.us',version:3};draw();});
  await page.getByRole('button',{name:'Ver respuestas'}).click();
  await page.getByRole('button',{name:'Enviar de nuevo',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Quizá',exact:true}).isDisabled(),true,'reload retains uncertain RSVP');
  assert.equal(sends.length,2,'reload must not replay the send');
  failSend=false;
  await page.getByRole('button',{name:'Enviar de nuevo',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.event-response-status').textContent === 'Respuesta enviada');
  assert.notEqual(sends.at(-1).sendToken,failedToken,'explicit resend uses a new token');
  assert.equal(await page.locator('.event-response-retry').count(),0,'the resend offer disappears after success');
  // Refresh confirming a changed selected response resolves uncertainty without a new send.
  failSend=true;
  const sendsBeforeConfirm=sends.length;
  await page.getByRole('button',{name:'Asistiré',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.event-response-status').textContent === 'Respuesta confirmada al actualizar');
  assert.equal(sends.length,sendsBeforeConfirm+1,'a confirmed refresh must not send anything else');
  assert.equal(await page.getByRole('button',{name:'Asistiré',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('.event-response-retry').count(),0,'a confirmed outcome needs no resend offer');
  failSend=false;
  const confirmedToken=sends.at(-1).sendToken;
  await page.getByRole('button',{name:'Asistiré',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.event-response-status').textContent === 'Respuesta enviada');
  assert.notEqual(sends.at(-1).sendToken,confirmedToken,'a confirmed attempt must not linger in the token map');
  // A pre-existing identical response cannot prove that a failed send arrived.
  selectedByMe='going';
  failSend=true;
  await page.getByRole('button',{name:'Asistiré',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.event-response-status').textContent === 'No se pudo confirmar la entrega anterior.');
  assert.equal(await page.getByRole('button',{name:'Asistiré',exact:true}).isDisabled(),true);
  const staleMatchingToken=sends.at(-1).sendToken;
  failSend=false;
  await page.getByRole('button',{name:'Enviar de nuevo',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.event-response-status').textContent === 'Respuesta enviada');
  assert.notEqual(sends.at(-1).sendToken,staleMatchingToken);
  // A still-unconfirmed outcome only rotates the token through the deliberate button.
  selectedByMe='not_going';
  failSend=true;
  await page.getByRole('button',{name:'Quizá',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.event-response-status').textContent === 'No se pudo confirmar la entrega anterior.');
  const staleToken=sends.at(-1).sendToken;
  failSend=false;
  await page.getByRole('button',{name:'Enviar de nuevo',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.event-response-status').textContent === 'Respuesta enviada');
  assert.notEqual(sends.at(-1).sendToken,staleToken,'only the deliberate resend gets a new token');
  assert.equal(sends.at(-2).sendToken,staleToken,'the deliberate click added exactly one new attempt');
  holdSend=true;
  const secondHeld=heldSend();
  await page.getByRole('button',{name:'No asistiré',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.event-response-status').textContent === 'Enviando respuesta…');
  await page.evaluate(() => {ctx={account:'beta',chat:'999@g.us',version:2};draw();});
  await secondHeld;releaseSend(); holdSend=false;
  await page.getByRole('button',{name:'Ver respuestas'}).click();
  await page.getByRole('button',{name:'Asistiré',exact:true}).waitFor();
  assert.equal(sends.at(-1).account,'alpha');
  assert.equal(await page.locator('.event-response-status').textContent(),'2 asistirán · 1 no asistirán · 0 quizá');
  holdSend=true; failSend=true;
  const thirdHeld=heldSend();
  await page.getByRole('button',{name:'Quizá',exact:true}).click();
  await thirdHeld;
  await page.evaluate(() => {ctx={account:'alpha',chat:'123@g.us',version:3};draw();});
  releaseSend(); holdSend=false;
  await page.waitForFunction(() => document.querySelector('.message-event-open')?.textContent === 'Ver respuestas');
  await page.evaluate(() => {ctx={account:'beta',chat:'999@g.us',version:4};draw();});
  await page.getByRole('button',{name:'Ver respuestas'}).click();
  await page.getByRole('button',{name:'Enviar de nuevo',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Quizá',exact:true}).isDisabled(),true,'account switch must retain an uncertain send');
  failSend=false;
  await page.getByRole('button',{name:'Enviar de nuevo',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.event-response-status').textContent === 'Respuesta enviada');
  const output=process.env.UI_OUTPUT_DIR;
  if(output) await mkdir(output,{recursive:true});
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>document.body.dataset.theme=theme,theme);
    for(const width of [800,390]) {
      await page.setViewportSize({width,height:600});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if(output)await page.screenshot({path:path.join(output,`event-${theme}-${width}.png`)});
    }
  }
  const sentBeforeRestrictions = sends.length;
  await page.evaluate(() => {allowSend=false;draw();});
  await page.getByRole('button',{name:'Ver respuestas'}).click();
  await page.getByRole('button',{name:'Asistiré',exact:true}).waitFor();
  for (const name of ['Asistiré','No asistiré','Quizá']) {
    assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true);
  }
  resultsAvailable=false;
  await page.evaluate(() => {allowSend=true;draw();});
  await page.getByRole('button',{name:'Ver respuestas'}).click();
  await page.waitForFunction(() => document.querySelector('.event-response-status')?.textContent.includes('no están disponibles'));
  assert.equal(await page.locator('.event-response-choices').count(),0);
  assert.equal(sends.length,sentBeforeRestrictions,'Read-only or unavailable events must not submit attendance');
  assert.deepEqual(errors,[]);
  console.log('Event UI: read, send feedback, uncertain refresh, stale-match guard, deliberate resend with new token, no auto replay, account switch, unavailable/read-only results and four layouts pass');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
