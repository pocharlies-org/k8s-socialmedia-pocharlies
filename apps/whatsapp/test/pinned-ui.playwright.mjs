import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const html=`<!doctype html><link rel="stylesheet" href="/styles.css"><body data-theme="light"><main style="width:100%;max-width:700px"><div id="messages"></div></main><script type="module">
import {installPinnedUI} from '/pinned-ui.mjs';
window.ctx={account:'alpha',chat:'123@g.us',version:1};window.opened=[];window.pending=[];
window.clock=Date.now();window.timers=[];
window.ui=installPinnedUI({messages:document.querySelector('#messages'),getContext:()=>ctx,
  now:()=>clock,schedule:fn=>{timers.push(fn);return timers.length;},cancel:()=>{},
  api:url=>new Promise(resolve=>pending.push({url,resolve})),openMessage:async id=>opened.push(id)});
window.answer=(index,items)=>{const params=new URL(pending[index].url,location.href).searchParams;pending[index].resolve({account:params.get('account'),chat:params.get('chat'),items});};
window.ready=true;
</script>`;
const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'}).end(html);return;}
  if(!['/pinned-ui.mjs','/styles.css'].includes(req.url)){res.writeHead(404).end();return;}
  res.writeHead(200,{'content-type':req.url.endsWith('.css')?'text/css':'text/javascript'}).end(await readFile(path.join(publicDir,req.url)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH||'/ms-playwright/chromium-1246/chrome-linux64/chrome',args:['--no-sandbox']});
try {
  const page=await browser.newPage({viewport:{width:800,height:600}});const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready);
  await page.evaluate(()=>{void ui.refresh();void ui.refresh();});
  assert.equal(await page.evaluate(()=>pending.length),1,'Concurrent reads deduplicate');
  await page.evaluate(()=>answer(0,[{id:'a',text:'Lugar de encuentro '.repeat(30),expiresAtMs:clock+5000},{id:'b',text:'Segunda nota',expiresAtMs:clock+5000}]));
  await page.getByRole('button',{name:'Siguiente mensaje fijado'}).waitFor();
  await page.locator('.pinned-message-link').click();
  assert.deepEqual(await page.evaluate(()=>opened),['a']);
  await page.getByRole('button',{name:'Siguiente mensaje fijado'}).click();
  await page.locator('.pinned-message-link').click();
  assert.deepEqual(await page.evaluate(()=>opened),['a','b']);
  for(const theme of ['light','dark'])for(const width of [800,390]){
    await page.evaluate(theme=>document.body.dataset.theme=theme,theme);await page.setViewportSize({width,height:600});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.UI_OUTPUT_DIR){await mkdir(process.env.UI_OUTPUT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_OUTPUT_DIR,`pins-${theme}-${width}.png`)});}
  }
  await page.evaluate(()=>{clock+=5001;timers.at(-1)();});
  assert.equal(await page.locator('.pinned-message-bar').isHidden(),true,'Expired pins disappear without polling');
  await page.evaluate(()=>{void ui.refresh({force:true});ctx={account:'beta',chat:'456@g.us',version:2};void ui.refresh();});
  await page.evaluate(()=>answer(1,[{id:'old-account',text:'stale',expiresAtMs:clock+5000}]));
  assert.equal(await page.locator('.pinned-message-bar').isHidden(),true,'Old account response cannot render');
  await page.evaluate(()=>answer(2,[{id:'beta',text:'Current account',expiresAtMs:clock+5000}]));
  await page.locator('.pinned-message-link').waitFor();
  assert.equal(await page.locator('.pinned-message-link span').textContent(),'Current account');
  await page.evaluate(()=>{ctx={account:'beta',chat:'',version:3};void ui.refresh();});
  assert.equal(await page.locator('.pinned-message-bar').isHidden(),true);
  await page.evaluate(()=>{ctx={account:'beta',chat:'456@g.us',version:4};void ui.refresh();void ui.refresh({force:true});});
  assert.equal(await page.evaluate(()=>pending.length),5,'Mutation refresh supersedes a pending read');
  await page.evaluate(()=>answer(4,[{id:'latest',text:'Just pinned',expiresAtMs:clock+5000}]));
  await page.waitForFunction(()=>document.querySelector('.pinned-message-link span')?.textContent==='Just pinned');
  await page.evaluate(()=>answer(3,[]));
  assert.equal(await page.locator('.pinned-message-link span').textContent(),'Just pinned','Earlier response cannot undo the confirmed mutation refresh');
  assert.deepEqual(errors,[]);
  console.log('Pinned UI: navigation, deduplication, expiry, stale account rejection and four layouts pass');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
