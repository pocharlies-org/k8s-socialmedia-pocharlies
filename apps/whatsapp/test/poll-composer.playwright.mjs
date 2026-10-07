import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const html = `<!doctype html><link rel="stylesheet" href="/styles.css"><body data-theme="light"><section class="feature-dialog feature-dialog-poll" style="width:min(500px,100vw);margin:auto"><header class="feature-dialog-header"><h2>Crear encuesta</h2></header><div class="feature-dialog-body"></div></section><script type="module">
import {createPollComposer} from '/poll-composer.mjs';
window.calls=[];window.pending=[];window.tokens=0;window.sent=0;window.current=true;
window.form=createPollComposer({isCurrent:()=>current,createToken:()=>String(++tokens),onSent:()=>sent++,submit:(payload,token)=>{calls.push({payload,token});return new Promise((resolve,reject)=>pending.push({resolve,reject}));}});
document.querySelector('.feature-dialog-body').append(form);window.ready=true;
</script>`;
const server = createServer(async (req, res) => {
  if (req.url === '/') return res.writeHead(200, {'content-type':'text/html'}).end(html);
  if (!['/styles.css', '/poll-composer.mjs', '/poll-draft.mjs'].includes(req.url)) return res.writeHead(404).end();
  res.writeHead(200, {'content-type':req.url.endsWith('.css')?'text/css':'text/javascript'}).end(await readFile(path.join(publicDir,req.url)));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH||'/ms-playwright/chromium-1246/chrome-linux64/chrome',args:['--no-sandbox']});
try {
  const page = await browser.newPage({viewport:{width:900,height:850}}); const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(()=>window.ready);
  await page.getByLabel('Pregunta',{exact:true}).fill('Que comida elegimos?');
  await page.getByLabel('Opci\u00f3n 1',{exact:true}).fill('Pasta, ensalada');
  await page.getByLabel('Opci\u00f3n 2',{exact:true}).fill('Arroz');
  await page.getByRole('button',{name:'A\u00f1adir opci\u00f3n',exact:true}).click();
  await page.getByLabel('Opci\u00f3n 3',{exact:true}).fill('Sopa');
  await page.getByRole('button',{name:'Subir opci\u00f3n 3',exact:true}).click();
  assert.equal(await page.getByLabel('Opci\u00f3n 2',{exact:true}).inputValue(),'Sopa');
  await page.getByRole('button',{name:'Eliminar opci\u00f3n 2',exact:true}).click();
  assert.equal(await page.getByLabel('Opci\u00f3n 2',{exact:true}).inputValue(),'Arroz');
  assert(await page.getByRole('button',{name:'Eliminar opci\u00f3n 1',exact:true}).isDisabled());
  for (const theme of ['light','dark']) for (const width of [900,390]) {
    await page.evaluate(theme=>document.body.dataset.theme=theme,theme); await page.setViewportSize({width,height:850});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(process.env.UI_OUTPUT_DIR){await mkdir(process.env.UI_OUTPUT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_OUTPUT_DIR,`poll-compose-${theme}-${width}.png`)});}
  }
  await page.getByRole('switch',{name:'Permitir varias respuestas'}).uncheck();
  await page.getByRole('button',{name:'Enviar encuesta',exact:true}).click();
  await page.evaluate(()=>form.requestSubmit());
  assert.equal(await page.evaluate(()=>calls.length),1,'Pending submit cannot duplicate');
  assert.deepEqual(await page.evaluate(()=>calls[0].payload),{question:'Que comida elegimos?',options:['Pasta, ensalada','Arroz'],selectableCount:1});
  assert(await page.getByLabel('Pregunta',{exact:true}).isDisabled());
  await page.evaluate(()=>pending[0].reject(new Error('Temporary failure')));
  await page.getByRole('alert').waitFor();
  await page.getByRole('button',{name:'Enviar encuesta',exact:true}).click();
  assert.equal(await page.evaluate(()=>calls[0].token===calls[1].token),true,'Retry preserves token');
  await page.evaluate(()=>pending[1].reject(new Error('Temporary failure')));
  await page.getByRole('button',{name:'Enviar encuesta',exact:true}).waitFor();
  await page.getByLabel('Opci\u00f3n 2',{exact:true}).fill('Verduras');
  await page.getByRole('button',{name:'Enviar encuesta',exact:true}).click();
  assert.equal(await page.evaluate(()=>calls[1].token!==calls[2].token),true,'Changed payload receives new token');
  await page.evaluate(()=>{current=false;pending[2].resolve();});
  await page.waitForFunction(()=>form.getAttribute('aria-busy')==='false');
  assert.equal(await page.evaluate(()=>sent),0,'Old context cannot close the current dialog');
  await page.evaluate(()=>current=true);
  await page.getByLabel('Opci\u00f3n 2',{exact:true}).fill('Pasta, ensalada');
  await page.getByRole('button',{name:'Enviar encuesta',exact:true}).click();
  assert.equal(await page.evaluate(()=>calls.length),3,'Duplicate options never send');
  await page.getByLabel('Opci\u00f3n 2',{exact:true}).fill('Verduras');
  for(let i=2;i<12;i++) await page.getByRole('button',{name:'A\u00f1adir opci\u00f3n',exact:true}).click();
  assert(await page.getByRole('button',{name:'A\u00f1adir opci\u00f3n',exact:true}).isDisabled());
  assert.equal(await page.locator('.poll-option-row').count(),12);
  assert.deepEqual(errors,[]);
  console.log('Poll composer: option rows, ordering, removal, limits, multiple choices, retry tokens, duplicate prevention, context guard and four layouts pass');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
