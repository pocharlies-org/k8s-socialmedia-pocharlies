import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const publicDir = path.join(root, 'apps/whatsapp/public');
const artifacts = process.env.QA_ARTIFACTS || path.join(root, 'docs/qa/whatsapp-media-zoom-2026-10-14');
await mkdir(artifacts, { recursive: true });
const fixture = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css">
<style>#fixture-app{width:100%;height:100dvh;padding:24px;box-sizing:border-box}#messages{display:flex;gap:12px}.media-image-button img{width:100px;height:80px}</style>
</head><body data-theme="dark"><main id="fixture-app"><h1>Galeria de adjuntos</h1><div id="messages"></div></main>
<script type="module">import {openImageViewer} from '/message-render.mjs';
for(let n=1;n<=2;n++){const b=document.createElement('button');b.className='media-image-button';b.dataset.viewerUrl='/image-'+n+'.svg';b.dataset.viewerName='Imagen '+n;b.setAttribute('aria-label','Abrir imagen '+n);b.innerHTML='<img alt="" src="'+b.dataset.viewerUrl+'">';b.onclick=()=>openImageViewer(b.dataset.viewerUrl,b.dataset.viewerName,document,b);document.querySelector('#messages').append(b);}window.__ready=true;</script></body></html>`;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://fixture').pathname;
  if (pathname === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end(fixture);
  if (/^\/image-[12]\.svg$/.test(pathname)) return response.writeHead(200, { 'content-type': 'image/svg+xml' }).end(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="${pathname.includes('1') ? '#326a80' : '#b87442'}"/><path d="M0 0L1200 900M1200 0L0 900" stroke="white" stroke-width="12"/><circle cx="600" cy="450" r="150" fill="#d4e8b5"/><text x="600" y="470" text-anchor="middle" font-size="60">${pathname}</text></svg>`);
  if (pathname === '/favicon.ico') return response.writeHead(204).end();
  const file = path.resolve(publicDir, `.${pathname}`);
  if (!file.startsWith(`${publicDir}${path.sep}`)) return response.writeHead(403).end();
  try { response.writeHead(200, { 'content-type': pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(await readFile(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1247/chrome-linux64/chrome' });
const report = [];
const geometry = page => page.evaluate(() => {
  const rect = element => { const r = element.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
  const image = document.querySelector('.media-viewer-image');
  return {app:rect(document.querySelector('#fixture-app')), pageScale:visualViewport.scale, viewportWidth:visualViewport.width,
    image: image && rect(image), stage:document.querySelector('.media-viewer-stage') && rect(document.querySelector('.media-viewer-stage')),
    zoom:Number(document.querySelector('.media-viewer-stage')?.dataset.zoom), transform:image && getComputedStyle(image).transform};
});
const waitZoom = (page, predicate) => page.waitForFunction(predicate);
const stablePage = (before, after) => { assert.deepEqual(after.app, before.app); assert.equal(after.pageScale, before.pageScale); assert.equal(after.viewportWidth, before.viewportWidth); };
const reset = async page => { await page.locator('.media-viewer-zoom-reset').click(); await waitZoom(page, () => Number(document.querySelector('.media-viewer-stage').dataset.zoom) === 1); };

try {
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile-390' : 'desktop-1280';
    const context = await browser.newContext({ viewport: {width:mobile ? 390 : 1280,height:mobile ? 844 : 900}, isMobile:mobile, hasTouch:mobile });
    await context.tracing.start({screenshots:true,snapshots:true});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => window.__ready);
      const before = await geometry(page);
      await page.getByRole('button',{name:'Abrir imagen 1',exact:true}).click();
      await page.waitForFunction(() => document.querySelector('.media-viewer-image')?.naturalWidth > 0);
      const fitted = await geometry(page);
      assert.equal(fitted.zoom, 1);
      assert.equal(await page.locator('.media-viewer-counter').textContent(), '1 / 2');
      await page.screenshot({path:path.join(artifacts,`${label}-fit.png`)});
      if (!mobile) {
        const focal = {x:fitted.image.x+fitted.image.width*.65,y:fitted.image.y+fitted.image.height*.45};
        await page.mouse.move(focal.x,focal.y);
        await page.mouse.wheel(0,-500);
        await waitZoom(page, () => Number(document.querySelector('.media-viewer-stage').dataset.zoom) > 1.4);
        const zoomed = await geometry(page);
        assert(zoomed.image.width > fitted.image.width*1.4);
        const ratio=zoomed.image.width/fitted.image.width;
        assert(Math.abs((focal.x-zoomed.image.x)/ratio-(focal.x-fitted.image.x)) < 2, 'wheel preserves cursor image point');
        await page.mouse.move(focal.x,focal.y); await page.mouse.down(); await page.mouse.move(focal.x+100,focal.y+60,{steps:8}); await page.mouse.up();
        const dragged = await geometry(page);
        assert(dragged.image.x > zoomed.image.x+20, 'drag moves zoomed image');
        await page.mouse.move(focal.x,focal.y); await page.mouse.down(); await page.mouse.move(1200,850,{steps:10}); await page.mouse.up();
        const clamped = await geometry(page);
        assert(clamped.image.x <= clamped.stage.x+1 && clamped.image.y <= clamped.stage.y+1, 'drag clamps upper edges');
        assert(clamped.image.x+clamped.image.width >= clamped.stage.x+clamped.stage.width-1 && clamped.image.y+clamped.image.height >= clamped.stage.y+clamped.stage.height-1, 'drag does not leave blank lower edges');
      } else {
        const cdp = await context.newCDPSession(page);
        const cx=fitted.stage.x+fitted.stage.width/2, cy=fitted.stage.y+fitted.stage.height/2;
        const points = distance => [{id:1,x:cx-distance,y:cy,radiusX:4,radiusY:4},{id:2,x:cx+distance,y:cy,radiusX:4,radiusY:4}];
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(35)});
        for (const d of [45,60,80,100]) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(d)});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await waitZoom(page, () => Number(document.querySelector('.media-viewer-stage').dataset.zoom) > 1.8);
        const pinched = await geometry(page); assert(pinched.image.width > fitted.image.width*1.8);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:3,x:cx,y:cy}]});
        for (const d of [20,40,60]) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:3,x:cx+d,y:cy+20}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        const dragged=await geometry(page); assert(dragged.image.x > pinched.image.x+20,'native touch drag moves image');
        await cdp.detach();
      }
      const zoomed = await geometry(page); stablePage(before,zoomed);
      await page.screenshot({path:path.join(artifacts,`${label}-zoom-drag.png`)});
      await reset(page);
      const resetState=await geometry(page); assert(Math.abs(resetState.image.width-fitted.image.width)<1);
      await page.locator('.media-viewer-zoom-in').click(); await waitZoom(page,()=>Number(document.querySelector('.media-viewer-stage').dataset.zoom)>1);
      await page.locator('.media-viewer-zoom-out').click(); await waitZoom(page,()=>Number(document.querySelector('.media-viewer-stage').dataset.zoom)===1);
      await page.keyboard.press('+'); await waitZoom(page,()=>Number(document.querySelector('.media-viewer-stage').dataset.zoom)>1);
      await page.keyboard.press('0'); await waitZoom(page,()=>Number(document.querySelector('.media-viewer-stage').dataset.zoom)===1);
      await page.locator('.media-viewer-zoom-in').click();
      await page.getByRole('button',{name:'Imagen siguiente',exact:true}).click();
      await waitZoom(page,()=>document.querySelector('.media-viewer-image').alt==='Imagen 2' && Number(document.querySelector('.media-viewer-stage').dataset.zoom)===1);
      await page.locator('.media-viewer-zoom-in').click();
      await page.keyboard.press('ArrowLeft');
      await waitZoom(page,()=>document.querySelector('.media-viewer-image').alt==='Imagen 1' && Number(document.querySelector('.media-viewer-stage').dataset.zoom)===1);
      await page.locator('.media-viewer-zoom-in').click(); await page.keyboard.press('Escape');
      assert.equal(await page.locator('.media-viewer').count(),0);
      assert.equal(await page.getByRole('button',{name:'Abrir imagen 1',exact:true}).evaluate(b=>b===document.activeElement),true);
      await page.getByRole('button',{name:'Abrir imagen 1',exact:true}).click();
      assert.equal((await geometry(page)).zoom,1);
      await page.getByRole('button',{name:'Cerrar imagen',exact:true}).click();
      stablePage(before,await geometry(page)); assert.deepEqual(errors,[]);
      report.push({label,passed:true,fitted,zoomed,errors});
      console.log(`PASS ${label}: localized zoom, drag, page scale, reset, navigation, reopen, Escape focus`);
    } finally { await context.tracing.stop({path:path.join(artifacts,`${label}-trace.zip`)}); await context.close(); }
  }
  await writeFile(path.join(artifacts,'results.json'),JSON.stringify({browser:'Chromium CDP touch (not native iPhone Safari)',chromiumVersion:browser.version(),report},null,2)+'\n');
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
