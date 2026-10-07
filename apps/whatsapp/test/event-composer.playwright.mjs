import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const html = `<!doctype html><link rel="stylesheet" href="/styles.css"><body data-theme="light"><section class="feature-dialog feature-dialog-poll" style="width:min(500px,100vw);margin:auto"><header class="feature-dialog-header"><h2>Crear evento</h2></header><div class="feature-dialog-body"></div></section><script type="module">
import {createEventComposer} from '/event-composer.mjs';
window.calls=[];window.pending=[];window.tokens=0;window.sent=0;window.current=true;
window.form=createEventComposer({now:()=>new Date('2026-09-28T12:00:00Z'),isCurrent:()=>current,createToken:()=>String(++tokens),onSent:()=>sent++,submit:(payload,token)=>{calls.push({payload,token});return new Promise((resolve,reject)=>pending.push({resolve,reject}));}});
document.querySelector('.feature-dialog-body').append(form);window.ready=true;
</script>`;
const server=createServer(async(req,res)=>{
  if(req.url==='/') return res.writeHead(200,{'content-type':'text/html'}).end(html);
  if(!['/styles.css','/event-composer.mjs','/event-draft.mjs'].includes(req.url))return res.writeHead(404).end();
  res.writeHead(200,{'content-type':req.url.endsWith('.css')?'text/css':'text/javascript'}).end(await readFile(path.join(publicDir,req.url)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH||'/ms-playwright/chromium-1246/chrome-linux64/chrome',args:['--no-sandbox']});
try {
  const page=await browser.newPage({viewport:{width:900,height:900},timezoneId:'Europe/Madrid',locale:'es-ES'});const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready);
  const start=page.getByLabel('Fecha y hora de inicio',{exact:true});
  const end=page.getByLabel('Fecha y hora de finalizaci\u00f3n',{exact:true});
  assert.equal(await start.inputValue(),'2026-09-29T18:00');
  assert(await end.isHidden());
  await page.getByLabel('Nombre del evento',{exact:true}).fill('Encuentro');
  await page.getByLabel('Descripci\u00f3n (opcional)',{exact:true}).fill('Trae algo para compartir');
  await page.getByLabel('Ubicaci\u00f3n (opcional)',{exact:true}).fill('Parque');
  await start.fill('2026-09-30T18:00');
  await page.getByRole('switch',{name:'A\u00f1adir fecha de finalizaci\u00f3n'}).check();
  await end.fill('2026-09-30T17:00');
  await page.getByRole('button',{name:'Crear evento',exact:true}).click();
  assert.equal(await page.evaluate(()=>calls.length),0);
  assert.match(await page.getByRole('alert').innerText(),/antes de empezar/);
  await end.fill('2026-09-30T20:00');
  assert(await page.getByRole('alert').isHidden(), 'Editing removes stale validation feedback');
  for(const theme of ['light','dark'])for(const width of [900,390]){
    await page.evaluate(theme=>document.body.dataset.theme=theme,theme);await page.setViewportSize({width,height:900});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(process.env.UI_OUTPUT_DIR){await mkdir(process.env.UI_OUTPUT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_OUTPUT_DIR,`event-compose-${theme}-${width}.png`)});}
  }
  await page.getByRole('button',{name:'Crear evento',exact:true}).click();
  await page.evaluate(()=>form.requestSubmit());
  assert.equal(await page.evaluate(()=>calls.length),1);
  assert.deepEqual(await page.evaluate(()=>calls[0].payload),{title:'Encuentro',description:'Trae algo para compartir',location:'Parque',dateTime:'2026-09-30T16:00:00.000Z',endDateTime:'2026-09-30T18:00:00.000Z'});
  assert(await start.isDisabled());
  await page.evaluate(()=>pending[0].reject(new Error('Temporary failure')));
  await page.getByRole('button',{name:'Crear evento',exact:true}).click();
  assert.equal(await page.evaluate(()=>calls[0].token===calls[1].token),true);
  await page.evaluate(()=>pending[1].reject(new Error('Temporary failure')));
  await page.getByRole('switch',{name:'A\u00f1adir fecha de finalizaci\u00f3n'}).uncheck();
  await page.getByRole('button',{name:'Crear evento',exact:true}).click();
  assert.equal(await page.evaluate(()=>calls[2].payload.endDateTime),'');
  assert.equal(await page.evaluate(()=>calls[1].token!==calls[2].token),true);
  await page.evaluate(()=>{current=false;pending[2].resolve();});
  await page.waitForFunction(()=>form.getAttribute('aria-busy')==='false');
  assert.equal(await page.evaluate(()=>sent),0);
  assert.deepEqual(errors,[]);
  console.log('Event composer: browser timezone, optional end date, ordering validation, description/location, pending deduplication, retry tokens, context guard and four layouts pass');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
