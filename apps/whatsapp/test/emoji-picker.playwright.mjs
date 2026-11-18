import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const source = fileURLToPath(new URL('../public/', import.meta.url));
const output = process.env.UI_OUTPUT_DIR || '/tmp/emoji-picker-qa';
await mkdir(output, {recursive: true});
const html = `<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head>
<body data-theme="light" style="display:block;padding:12px;margin:0;box-sizing:border-box"><main style="max-width:480px;margin:auto;background:var(--surface);padding:12px;border-radius:12px;box-sizing:border-box"><div id="picker"></div><output id="chosen"></output></main>
<script type="module">
import {createEmojiPicker} from '/emoji-picker.mjs';
window.current=true; window.selectionCount=0;
window.mount=account=>{
 document.querySelector('#picker').replaceChildren(createEmojiPicker({account,isCurrent:()=>window.current,onSelect:async emoji=>{
  window.selectionCount++; document.querySelector('#chosen').textContent=emoji;
  if(window.deferSelection)await new Promise(resolve=>window.finishSelection=resolve);
 }}));
};window.mount('personal');
</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') {res.setHeader('Content-Type', 'text/html'); res.end(html); return;}
    const file = resolve(source, `.${new URL(req.url, 'http://local').pathname}`);
    if (!file.startsWith(source)) {res.writeHead(403).end(); return;}
    res.setHeader('Content-Type', {'.mjs':'text/javascript', '.css':'text/css', '.json':'application/json'}[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome', args:['--no-sandbox']});
const errors=[]; const requests=[];
try {
  for (const width of [1200, 390]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({viewport:{width,height:850}});
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.goto(origin);
    await page.evaluate(theme => {document.body.dataset.theme=theme;}, theme);
    const items=page.locator('.emoji-picker-grid .emoji-picker-item');
    await items.first().waitFor();
    assert(await items.count()>100);
    await page.getByRole('searchbox',{name:'Buscar emoji'}).fill('corazon rojo');
    const heart=page.getByRole('button',{name:'coraz\u00f3n rojo',exact:true});
    await heart.waitFor(); await heart.click();
    assert.equal(await page.locator('#chosen').textContent(),'\u2764\ufe0f');
    await page.getByRole('button',{name:'Recientes',exact:true}).click();
    assert.equal(await items.count(),1);
    await page.getByRole('searchbox',{name:'Buscar emoji'}).fill('mano saludando');
    await page.getByLabel('Tono de piel').selectOption('3');
    const hand=page.getByRole('button',{name:'mano saludando: tono de piel medio',exact:true});
    await hand.click();
    assert.equal(await page.locator('#chosen').textContent(),'\ud83d\udc4b\ud83c\udffd');
    await hand.click({button:'right'});
    await page.locator('.emoji-picker-variants').getByRole('button',{name:'mano saludando: tono de piel oscuro',exact:true}).click();
    assert.equal(await page.locator('#chosen').textContent(),'\ud83d\udc4b\ud83c\udfff');
    await page.getByRole('searchbox',{name:'Buscar emoji'}).fill('');
    await page.getByRole('button',{name:'personas y cuerpo',exact:true}).click();
    await items.first().focus(); await page.keyboard.press('ArrowRight');
    assert(await items.nth(1).evaluate(element=>element===document.activeElement));
    const bounds=await page.locator('.emoji-picker').boundingBox();
    assert(bounds.x>=0 && bounds.x+bounds.width<=width);
    assert(await page.locator('.emoji-picker-grid').evaluate(element=>element.scrollHeight>element.clientHeight));
    await page.screenshot({path:resolve(output,`emoji-${theme}-${width}.png`)});
    await page.evaluate(()=>window.mount('secondary'));
    await items.first().waitFor();
    assert.equal(await page.getByLabel('Tono de piel').inputValue(),'0');
    await page.getByRole('button',{name:'Recientes',exact:true}).click();
    assert.equal(await items.count(),0);
    await page.getByRole('button',{name:'emoticonos y emoci\u00f3n',exact:true}).click();
    const before=await page.evaluate(()=>{window.deferSelection=true;return window.selectionCount;});
    await items.first().click(); await items.nth(1).click();
    assert.equal(await page.evaluate(()=>window.selectionCount),before+1);
    await page.evaluate(()=>{window.finishSelection();window.deferSelection=false;});
    await page.locator('.emoji-picker:not([aria-busy])').waitFor();
    await page.evaluate(()=>{window.current=false;});
    await items.first().click();
    assert.equal(await page.evaluate(()=>window.selectionCount),before+1);
    await page.close();
  }
  const retry=await browser.newPage(); let attempts=0;
  retry.on('pageerror', error=>errors.push(error.message));
  await retry.route('**/emoji/catalog-es.json', async route=>{if(++attempts===1) await route.fulfill({status:503,body:'unavailable'});else await route.continue();});
  await retry.goto(origin); await retry.getByRole('button',{name:'Reintentar'}).click();
  await retry.locator('.emoji-picker-item').first().waitFor(); assert.equal(attempts,2);
  assert.deepEqual(errors,[]);
  assert(requests.every(url=>url.startsWith(origin)), 'Picker made an external request');
  console.log('PASS emoji picker: search, categories, tones, variants, recents/account isolation, keyboard, pending/stale selection, retry, 4 layouts; no external requests/page errors');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
