import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const artifacts = process.env.PLAYWRIGHT_ARTIFACT_DIR || '/tmp/sidebar-search-layout-qa';
await mkdir(artifacts, {recursive: true});
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  if (path === '/') {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css">
      <aside class="chat-sidebar" style="width:min(100vw,420px);height:100dvh">
        <header class="chat-sidebar-header"><h1>SocialMedia</h1></header>
        <label class="search"><input id="search" type="search"></label><div id="chats" class="chat-list"></div>
      </aside>`);
  } else if (['/styles.css', '/sidebar-search.mjs'].includes(path)) {
    response.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(new URL(`../public${path}`, import.meta.url)));
  } else response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  for (const viewport of [{width:1440,height:900}, {width:1504,height:1658}, {width:390,height:844}, {width:320,height:568}]) {
    const page = await browser.newPage({viewport});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const {installSidebarMessageSearch} = await import('/sidebar-search.mjs');
      const input = document.querySelector('#search');
      const chatList = document.querySelector('#chats');
      const chats = Array.from({length:12}, (_, i) => ({id:`chat-${i}`,name:`Maria ${i}`}));
      for (const chat of chats) {
        const row = document.createElement('button'); row.className = 'chat-item'; row.textContent = chat.name;
        row.dataset.chatId = chat.id;
        row.style.minHeight = '72px'; chatList.append(row);
      }
      window.opened = [];
      const ui = installSidebarMessageSearch({documentRef:document,input,chatList,getAccount:()=> 'personal',getChats:()=>chats,delay:0,
        request:async ({query,cursor}) => ({query,results:Array.from({length:50}, (_,i)=>({chatId:'chat-0',messageId:`${cursor || 'first'}-${i}`,chatName:'Maria 0',text:`Mensaje ${i}`,timestamp:'2026-10-10T09:00:00Z'})),nextCursor:cursor ? null : 'next'}),
        openMessage:async (...args)=>window.opened.push(args),showError:message=>{throw new Error(message);}});
      window.searchUI = ui;
      input.oninput = () => ui.changed();
    });
    await page.locator('#search').fill('maria');
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-message-result').length === 50);
    const conversations = page.getByRole('tab', {name:/Conversaciones/});
    const messages = page.getByRole('tab', {name:/Mensajes/});
    assert.equal(await conversations.getAttribute('aria-selected'), 'true');
    assert(await page.locator('#chats').isVisible());
    assert(!(await page.locator('.sidebar-message-search').isVisible()));
    const list = await page.locator('#chats').boundingBox();
    assert(list.height > viewport.height - 220, JSON.stringify({viewport,list}));
    assert(list.y + list.height <= viewport.height + 1);
    await messages.click();
    assert.equal(await messages.getAttribute('aria-selected'), 'true');
    assert(!(await page.locator('#chats').isVisible()));
    const results = await page.locator('.sidebar-search-results').boundingBox();
    assert(results.height > viewport.height - 260, JSON.stringify({viewport,results}));
    assert(results.y + results.height <= viewport.height + 1);
    await page.screenshot({path:`${artifacts}/search-messages-${viewport.width}x${viewport.height}.png`});
    await page.locator('#search').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.sidebar-message-result').first().evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.opened.length), 1);
    await page.locator('.sidebar-search-more').scrollIntoViewIfNeeded();
    await page.locator('.sidebar-search-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-message-result').length === 100);
    assert.equal(await messages.getAttribute('aria-selected'), 'true');
    await conversations.click();
    assert(await page.locator('#chats').isVisible());
    await page.screenshot({path:`${artifacts}/search-${viewport.width}x${viewport.height}.png`});
    await page.locator('#search').fill('');
    assert(!(await conversations.isVisible()));
    assert(await page.locator('#chats').isVisible());
    assert(!(await page.locator('.sidebar-message-search').isVisible()));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // Exercise the real DOM observer used when app.js replaces filtered chat rows.
    await page.evaluate(() => document.querySelector('#chats').replaceChildren());
    await page.locator('#search').fill('no matching conversation');
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-message-result').length === 50);
    assert.equal(await messages.getAttribute('aria-selected'), 'true');
    await conversations.click();
    assert(await page.getByText('No se encontraron conversaciones.').isVisible());
    await page.evaluate(() => {
      const row = document.createElement('button'); row.className = 'chat-item'; row.dataset.chatId = 'chat-0';
      document.querySelector('#chats').append(row);
    });
    await page.waitForFunction(() => document.querySelector('#sidebar-conversations-tab').textContent === 'Conversaciones (1)');
    assert.equal(await conversations.getAttribute('aria-selected'), 'true');
    await page.evaluate(() => window.searchUI.viewChanged(true));
    assert(!(await conversations.isVisible()));
    assert(!(await page.locator('.sidebar-message-search').isVisible()));
    assert(await page.locator('#chats').isVisible());
    await page.evaluate(() => { window.searchUI.viewChanged(false); document.body.dataset.theme = 'light'; });
    await page.locator('#search').fill('maria');
    assert(await conversations.isVisible());
    await page.screenshot({path:`${artifacts}/search-light-${viewport.width}x${viewport.height}.png`});
    await page.close();
  }
  console.log('PASS search tabs use full height, preserve selection, keyboard navigation and pagination at desktop/mobile sizes');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
