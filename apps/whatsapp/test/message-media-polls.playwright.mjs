import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) {
  console.log('SKIP message-media-polls: PLAYWRIGHT_MODULE is not configured');
  process.exit(0);
}
const { chromium } = await import(modulePath);
const encoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=160x120:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '2', '-c:v', 'libvpx', '-c:a', 'libvorbis', '-f', 'webm', 'pipe:1']);
assert.equal(encoded.status, 0, encoded.stderr?.toString());
const bytes = encoded.stdout;
let mediaRequests = 0;
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  if (path === '/') {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><link rel="stylesheet" href="/styles.css"><main id="messages"></main>');
  } else if (['/message-render.mjs', '/settings-ui.mjs', '/styles.css'].includes(path)) {
    response.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(new URL(`../public${path}`, import.meta.url)));
  } else if (path === '/fixture.webm') {
    mediaRequests++;
    const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    response.writeHead(range ? 206 : 200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(range ? {'content-range': `bytes ${start}-${end}/${bytes.length}`} : {}) });
    response.end(bytes.subarray(start, end + 1));
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: {width: 390, height: 844} });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    const { renderMessage } = await import('/message-render.mjs');
    const policy = { enabled: () => false, cachedUrl: () => '/fixture.webm', release() {}, autoMaxBytes: 1024 };
    const host = document.querySelector('#messages');
    host.append(renderMessage({id:'video',attachments:[{url:'/fixture.webm',mimeType:'video/webm'}]}, {mediaPolicy:policy}));
    host.append(renderMessage({id:'poll',type:'POLL',text:'Cena',metadata:{kind:'poll',options:['Si','No'],results:{available:true,totalVoters:1,options:[{name:'Si',count:1,voters:[{id:'1',name:'<Ana>'}]},{name:'No',count:0,voters:[]}]}}}));
    host.append(renderMessage({id:'markers',fromMe:true,text:'conservado',isDeleted:true,metadata:{viewOnce:true},deliveryStatus:'read'}));
  });
  await page.waitForTimeout(200);
  assert.equal(mediaRequests, 0, 'disabled auto downloading must not fetch video before play');
  assert.equal(await page.locator('video').evaluate(video => video.controls && video.playsInline && video.preload === 'none'), true);
  await page.locator('video').evaluate(async video => { video.muted = true; await video.play(); });
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0);
  assert(mediaRequests > 0);
  const playback = await page.locator('video').evaluate(video => {
    video.pause(); video.currentTime = 1; video.volume = .25;
    return {paused:video.paused,time:video.currentTime,volume:video.volume,fullscreen:typeof video.requestFullscreen};
  });
  assert.deepEqual(playback, {paused:true,time:1,volume:.25,fullscreen:'function'});
  await page.locator('video').evaluate(video => video.requestFullscreen());
  assert.equal(await page.evaluate(() => document.fullscreenElement === document.querySelector('video')), true);
  await page.evaluate(() => document.exitFullscreen());
  await page.locator('.message-poll-voters summary').first().click();
  assert.equal(await page.locator('.message-poll-voter-list').textContent(), '<Ana>');
  assert.equal(await page.locator('.message-poll-voter-list ana').count(), 0);
  await page.locator('.message-poll-voters summary').nth(1).click();
  assert(await page.getByText('Sin votos registrados para esta opcion', {exact:true}).isVisible());
  assert.equal(await page.locator('.message-poll-option[aria-pressed="true"]').count(), 0);
  assert.equal(await page.locator('.message-view-once').count(), 1);
  assert.equal(await page.locator('.message-deleted').count(), 1);
  assert.equal(await page.locator('.message-status').getAttribute('aria-label'), 'Leido');
  // Audio controls use the same media fixture, with a cached policy to avoid a download gate.
  await page.evaluate(async () => {
    const {renderMessage} = await import('/message-render.mjs');
    document.querySelector('#messages').append(renderMessage({id:'audio',attachments:[{url:'/fixture.webm',mimeType:'audio/webm',name:'nota'}]}, {mediaPolicy:{enabled:()=>true,cachedUrl:()=>'/fixture.webm',release(){},autoMaxBytes:1024}}));
  });
  await page.getByRole('button', {name:'Reproducir nota',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('audio').currentTime > 0);
  await page.getByRole('button', {name:'Pausar nota',exact:true}).click();
  for (const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    const geometry = await page.locator('.audio-controls').evaluate(element => {
      const box = element.getBoundingClientRect();
      const button = element.querySelector('.audio-toggle').getBoundingClientRect();
      return {left:button.left,right:box.right,center:Math.abs(button.top+button.height/2-(box.top+box.height/2)),width:button.width,height:button.height};
    });
    assert(geometry.left >= 0 && geometry.right <= width, JSON.stringify(geometry));
    assert.equal(geometry.center, 0);
    assert.equal(geometry.width, geometry.height);
  }
  console.log('PASS native playback, audio alignment, poll voter details and preserved markers');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
