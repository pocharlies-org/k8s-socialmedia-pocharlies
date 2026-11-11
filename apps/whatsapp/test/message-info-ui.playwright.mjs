import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createNovedadesTab, startPublicFixture, viewportMetrics } from './browser-fixture.mjs';

const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css">
<body class="chat-open"><div id="messages"><div class="message" data-message-id="42">Sent</div><div class="message" data-message-id="43">Incoming</div><div class="message" data-message-id="local-1">Pending</div></div>
<script type="module">
import {installFeatureUI} from '/features-ui.mjs';
window.requests=[]; window.xss=0;
window.state={account:'alpha',chat:'group',selectedChat:{id:'group',isGroup:true}};
window.ui=installFeatureUI({state,documentRef:document,windowRef:window,
 query:(path,extra)=>path+'?'+new URLSearchParams({account:state.account,chat:state.chat,...extra}),
 api:async url=>url.startsWith('/api/messages/info')?new Promise(resolve=>requests.push({url,resolve})):({})});
ui.messagesChanged([{id:'42',fromMe:true,text:'<img src=x onerror="xss++">'},{id:'43',fromMe:false,text:'Incoming'},{id:'local-1',fromMe:true,text:'Pending'}]);
window.answer=(index,extra={})=>requests[index].resolve({account:'alpha',chatId:'group',messageId:'42',fromMe:true,recipientCount:null,completeRecipients:false,
 receipts:[{participantId:'a',name:'<img src=x onerror="xss++">',readAt:'2026-10-11T10:00:00Z',deliveredAt:'2026-10-11T09:00:00Z',playedAt:null}],...extra});
window.ready=true;
</script>`;
const server = await startPublicFixture({ html });
const errors = [];
const { browser, tab } = await createNovedadesTab(errors);
try {
  await tab.goto(`http://127.0.0.1:${server.address().port}`);
  await tab.waitForFunction(() => window.ready);
  const open = async () => {
    await tab.locator('[data-message-id="42"] .feature-message-action').click();
    await tab.getByRole('button', { name: 'Información del mensaje', exact: true }).click();
  };
  for (const id of ['43', 'local-1']) {
    await tab.locator(`[data-message-id="${id}"] .feature-message-action`).click();
    assert.equal(await tab.getByRole('button', { name: 'Información del mensaje', exact: true }).count(), 0);
    await tab.keyboard.press('Escape');
  }
  await open();
  assert.match(await tab.locator('.feature-message-info').textContent(), /Cargando/);
  await tab.evaluate(() => answer(0));
  await tab.getByRole('button', { name: 'Actualizar', exact: true }).waitFor();
  assert.equal(await tab.evaluate(() => xss), 0);
  assert.equal(await tab.locator('.feature-message-info img').count(), 0);
  assert.equal(await tab.locator('.feature-message-info svg').count(), 0);
  assert.match(await tab.locator('.feature-message-info').textContent(), /total desconocido/);
  for (const width of [1280, 390]) {
    await tab.setViewportSize({ width, height: 800 });
    const metrics = await viewportMetrics(tab);
    assert.ok(metrics.documentWidth <= metrics.viewportWidth, 'Panel fits the viewport');
    assert.ok(await tab.getByRole('button', { name: 'Actualizar', exact: true }).isVisible());
    if (process.env.UI_OUTPUT_DIR) {
      await mkdir(process.env.UI_OUTPUT_DIR, { recursive: true });
      await tab.screenshot({ path: join(process.env.UI_OUTPUT_DIR, `message-info-${width}.png`) });
    }
  }
  await tab.keyboard.press('Escape');
  assert.equal(await tab.locator('.feature-message-info').count(), 0);
  await tab.setViewportSize({ width: 1280, height: 800 });
  await open();
  await tab.mouse.click(20, 400);
  assert.equal(await tab.locator('.feature-message-info').count(), 0, 'Outside click closes panel');
  await tab.evaluate(() => answer(1));
  assert.equal(await tab.locator('.feature-message-info').count(), 0, 'Closed panel stays closed after response');
  await open();
  await tab.evaluate(() => { state.account='beta'; ui.accountChanged('beta'); });
  await tab.evaluate(() => answer(2));
  assert.equal(await tab.locator('.feature-message-info').count(), 0);
  await tab.evaluate(() => { state.account='alpha'; ui.accountChanged('alpha'); ui.chatChanged({id:'group',isGroup:true}); ui.messagesChanged([{id:'42',fromMe:true,text:'Historical message'}]); });
  await open();
  await tab.evaluate(() => answer(3,{receipts:[],recovery:{state:'pending',retryAfterMs:500}}));
  await tab.waitForFunction(() => requests.length === 5);
  assert.match(await tab.locator('.feature-message-info').textContent(), /Sin datos/);
  await tab.evaluate(() => answer(4,{receipts:[],recovery:{state:'complete'}}));
  await tab.waitForFunction(() => document.querySelector('.feature-message-info')?.textContent.includes('WhatsApp no ha facilitado'));
  assert.doesNotMatch(await tab.locator('.feature-message-info').textContent(), /Leído por · 0|Entregado a · 0/);
  if (process.env.UI_OUTPUT_DIR) {
    for (const width of [1280, 390]) {
      await tab.setViewportSize({ width, height: 800 });
      await tab.screenshot({ path: join(process.env.UI_OUTPUT_DIR, `message-info-sin-datos-${width}.png`) });
    }
    await tab.setViewportSize({ width: 1280, height: 800 });
  }
  await tab.getByRole('button',{name:'Actualizar',exact:true}).click();
  await tab.evaluate(() => answer(5,{receipts:[],recovery:{state:'pending',retryAfterMs:500}}));
  await tab.waitForFunction(() => document.querySelector('.feature-message-info')?.textContent.includes('Buscando confirmaciones'));
  await tab.keyboard.press('Escape');
  await tab.waitForTimeout(700);
  assert.equal(await tab.evaluate(() => requests.length), 6, 'Closing panel cancels recovery timer');
  await open();
  await tab.evaluate(() => answer(6,{receipts:[],recovery:{state:'pending',retryAfterMs:500}}));
  await tab.waitForFunction(() => requests.length === 8);
  await tab.evaluate(() => answer(7,{recipientCount:2,recovery:{state:'complete'}}));
  await tab.waitForFunction(() => document.querySelector('.feature-message-info-readAt')?.textContent.includes('1 / 2'));
  assert.match(await tab.locator('.feature-message-info-deliveredAt').textContent(), /1 \/ 2/);
  assert.equal(await tab.evaluate(() => xss), 0);
  await tab.keyboard.press('Escape');
  assert.equal(await tab.evaluate(() => requests[0].url), '/api/messages/info?account=alpha&chat=group&messageId=42');
  assert.deepEqual(errors, []);
  console.log('Message info browser: scoped actions, escaping, stale responses, desktop/mobile, bounded recovery and populated/empty recovery completion pass');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
