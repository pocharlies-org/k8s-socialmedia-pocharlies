#!/usr/bin/env node
/*
 * Live chunk-stream QA for the Social Media Agent panel. A real SSE server emits the
 * sanitized agent events (activity/delta/result/error) with real gaps between writes so
 * the test can watch a delayed thinking receipt, a real tool label, a partial answer
 * that lands before the result, and the typing area removed the instant the answer is
 * final. It also exercises the optimistic bubble during a slow stream, the JSON fallback,
 * an SSE error that leaves an incomplete answer plus Reintentar with a stable turnId, an
 * off-screen turn that survives switching chats and still receives its final result, and
 * per-contact / per-account isolation. Mock data only; no real WhatsApp message is sent.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const {DRAFT_INSTRUCTION, DRAFT_LABEL} = await import(new URL('../public/draft-suggest.mjs', import.meta.url).href);
const publicDir = path.resolve(process.env.UI_SOURCE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'));
const shotsDir = process.env.QA_SHOTS_DIR || '/tmp/socialmedia-playwright-qa';

const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome'});
const page = await browser.newPage();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, label, timeout = 15000) => {
  const start = Date.now();
  for (;;) {
    if (await condition()) return true;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${label}`);
    await sleep(25);
  }
};

const history = new Map([
  ['personal:one', [{role: 'user', content: 'Consulta previa'}, {role: 'assistant', content: 'Respuesta previa'}]],
  ['personal:three', [{role: 'user', content: 'Consulta Tres'}, {role: 'assistant', content: 'Respuesta Tres previa'}]],
  ['secondary:one', [{role: 'user', content: 'Historial secundaria'}]]
]);
const sessionCalls = [];
const chatRequests = [];      // {key, message, turnId, allowPropose, allowSend, attempt}
const errorsSeen = [];
const gates = new Map();
let sendCount = 0;
const waitGate = id => { const entry = {}; entry.promise = new Promise(resolve => { entry.release = resolve; }); gates.set(id, entry); return entry.promise; };
const releaseGate = id => { const entry = gates.get(id); if (entry) { gates.delete(id); entry.release(); } };

// Emit a scripted SSE turn. A frame with only `await` pauses the stream without emitting
// an event; `raw` writes a pre-formatted chunk (used to split a frame across writes).
const stream = async (res, frames) => {
  res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no'});
  for (const frame of frames) {
    if (frame.await) await frame.await;                 // gate: an already-built promise
    if (frame.delay) await sleep(frame.delay);          // built lazily so gaps are real
    if (frame.raw) { res.write(frame.raw); continue; }
    if (!frame.event) continue;
    res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
  }
  res.end();
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const pathname = url.pathname;
  const json = payload => { response.writeHead(200, {'content-type': 'application/json; charset=utf-8'}); response.end(JSON.stringify(payload)); };
  try {
    if (request.method === 'POST' && pathname === '/api/ai/chat') {
      const body = JSON.parse((await readBody(request)) || '{}');
      assert.equal(body.stream, true, 'the live UI stopped requesting streamed answers');
      assert.match(String(body.turnId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'live UI sent a non-UUID turnId');
      const key = `${body.account}:${body.chat}`;
      const attempt = chatRequests.filter(entry => entry.key === key && entry.message === body.message).length + 1;
      chatRequests.push({key, message: body.message, turnId: body.turnId, allowPropose: body.allowPropose, allowSend: body.allowSend, attempt});
      const sessionId = `session-${key}`;
      const remember = text => { const store = history.get(key) || []; store.push({role: 'user', content: body.message}, {role: 'assistant', content: text}); history.set(key, store); };

      if (body.message === 'JSONfallback') { remember('Respuesta por JSON'); return json({sessionId, text: 'Respuesta por JSON'}); }
      if (body.message === 'Flujo' && attempt === 1) {
        remember('Parcial del resumen todavía sin cerrar y **final**.');
        const toTool = waitGate('flujo-tool');
        const toDelta = waitGate('flujo-delta');
        const toFinal = waitGate('flujo-final');
        return stream(response, [
          {event: 'activity', data: {phase: 'thinking', label: 'Pensando'}},
          {await: toTool},
          {event: 'activity', data: {phase: 'tool', label: 'Leyendo los últimos mensajes'}},
          {await: toDelta},
          {event: 'delta', data: {text: 'Parcial del resumen'}},
          {event: 'delta', data: {text: ' todavía sin cerrar'}},
          {await: toFinal},
          {event: 'result', data: {sessionId, text: 'Parcial del resumen todavía sin cerrar y **final**.'}}
        ]);
      }
      if (body.message === 'ErrorParcial' && attempt === 1) {
        return stream(response, [
          {event: 'activity', data: {phase: 'tool', label: 'Redactando'}},
          {event: 'delta', data: {text: 'Voy a responder'}},
          {delay: 300},
          {event: 'error', data: {error: 'Hermes cortó la respuesta'}}
        ]);
      }
      if (body.message === 'Pausa') {
        remember('Resultado tras cambiar de chat');
        const resume = waitGate('pausa');
        return stream(response, [
          {event: 'activity', data: {phase: 'thinking', label: 'Pensando'}},
          {await: resume},
          {event: 'delta', data: {text: 'Resultado tras cambiar de chat'}},
          {event: 'result', data: {sessionId, text: 'Resultado tras cambiar de chat'}}
        ]);
      }
      if (body.message === 'Cola') {
        remember('Respuesta de Cola');
        const resume = waitGate('cola');
        return stream(response, [
          {event: 'activity', data: {phase: 'thinking', label: 'Pensando'}},
          {await: resume},
          {event: 'result', data: {sessionId, text: 'Respuesta de Cola'}}
        ]);
      }
      if (body.message === DRAFT_INSTRUCTION) {
        remember('Propuesta solicitada');
        return stream(response, [
          {event: 'activity', data: {phase: 'tool', label: 'Pensando un borrador'}},
          {delay: 250},
          {event: 'result', data: {sessionId, text: 'Propuesta solicitada'}}
        ]);
      }
      // Default: split the result frame across two chunk writes to test the reader.
      const answer = `Respuesta a ${body.message}`;
      remember(answer);
      return stream(response, [
        {event: 'activity', data: {phase: 'thinking', label: 'Pensando'}},
        {raw: 'event: result\ndata: '},
        {delay: 150},
        {raw: JSON.stringify({sessionId, text: answer}) + '\n\n'}
      ]);
    }

    const body = request.method === 'POST' ? JSON.parse((await readBody(request)) || '{}') : {};
    const account = url.searchParams.get('account') || body.account;
    const chat = url.searchParams.get('chat') || body.chat;
    const key = `${account}:${chat}`;
    if (pathname === '/api/accounts') return json({accounts: [{id: 'personal', label: 'Personal'}, {id: 'secondary', label: 'Secundaria'}], sendingEnabled: true});
    if (pathname === '/api/chats') return json({chats: account === 'secondary' ? [{id: 'one', name: 'Uno secundario'}] : [{id: 'one', name: 'Uno'}, {id: 'two', name: 'Dos'}, {id: 'three', name: 'Tres'}]});
    if (pathname === '/api/messages') return json({messages: []});
    if (pathname === '/api/send') { sendCount++; return json({messageId: 'wa-x'}); }
    if (pathname === '/api/ai/session') { sessionCalls.push(key); return json({sessionId: `session-${key}`, messages: history.get(key) || []}); }
    if (pathname === '/api/ai/proposals') return json({proposals: []});

    const filename = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filename.startsWith(`${publicDir}${path.sep}`)) return response.writeHead(403).end();
    const asset = await readFile(filename).catch(() => null);
    if (!asset) return response.writeHead(404).end();
    response.writeHead(200, {'content-type': {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'}[path.extname(filename)] || 'application/octet-stream'}).end(asset);
  } catch (error) {
    errorsSeen.push(`server: ${error.message}`);
    if (!response.headersSent) response.writeHead(500, {'content-type': 'application/json'}).end(JSON.stringify({error: error.message}));
    else response.end();
  }
});
const readBody = request => new Promise(resolve => { let data = ''; request.on('data', chunk => { data += chunk; }); request.on('end', () => resolve(data)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const shot = async name => { try { await mkdir(shotsDir, {recursive: true}); await page.screenshot({path: path.join(shotsDir, name)}); } catch { /* evidence only */ } };
const requestsFor = message => chatRequests.filter(entry => entry.message === message);

page.on('pageerror', error => errorsSeen.push(`page: ${error.message}`));
const openPanel = async () => { if (await page.locator('#ai-panel').isHidden()) await page.locator('#ai-toggle').click(); await page.locator('#ai-panel').waitFor({state: 'visible'}); };
const closePanel = async () => { if (await page.locator('#ai-panel').isVisible()) await page.locator('#ai-close').click(); await page.locator('#ai-panel').waitFor({state: 'hidden'}); };

try {
  await page.goto(base);
  await page.locator('.chat-item').first().click();
  await openPanel();
  await page.locator('.ai-bubble-in').filter({hasText: 'Respuesta previa'}).first().waitFor();

  // 1. Full streamed turn: thinking, real tool label, partial before result, then removal.
  await page.locator('#ai-prompt').fill('Flujo');
  await page.locator('#ai-prompt').press('Enter');
  await page.locator('.ai-bubble-out').filter({hasText: 'Flujo'}).waitFor();
  assert.equal(await page.locator('#ai-prompt').inputValue(), '', 'composer not cleared optimistically during a live stream');
  // Each phase is released from the test only after the previous one is observed, so
  // no React batch can hide a phase behind a faster follow-up frame.
  await page.locator('.ai-activity').filter({hasText: 'Pensando'}).waitFor();
  releaseGate('flujo-tool');
  await page.locator('.ai-activity').filter({hasText: 'Leyendo los últimos mensajes'}).waitFor();
  assert.equal(await page.locator('.ai-activity .ai-tool-icon').count(), 1, 'a tool phase did not mark the activity icon');
  releaseGate('flujo-delta');
  await page.locator('.ai-bubble-in').filter({hasText: 'Parcial del resumen todavía sin cerrar'}).waitFor();
  assert.equal(await page.locator('.ai-activity').filter({hasText: 'Escribiendo'}).count(), 1, 'the writing receipt did not show while a delta streamed');
  assert.equal((await page.locator('.ai-bubble-in').last().innerText()).includes('final'), false, 'the final answer leaked before the result event');
  await shot('live-agent-partial-before-final.png');
  releaseGate('flujo-final');
  await page.locator('.ai-bubble-in strong').filter({hasText: 'final'}).last().waitFor();
  await until(async () => (await page.locator('.ai-activity').count()) === 0, 'the typing area to be removed right after the result', 3000);
  assert.equal(await page.locator('.ai-incomplete').count(), 0, 'a complete streamed answer was marked incomplete');
  await shot('live-agent-desktop-response.png');

  // 2. Result frame split across two chunk writes still reassembles.
  await page.locator('#ai-prompt').fill('Trocea');
  await page.locator('#ai-prompt').press('Enter');
  await page.locator('.ai-bubble-in').filter({hasText: 'Respuesta a Trocea'}).last().waitFor();
  assert.equal(await page.locator('.ai-activity').count(), 0, 'the split-frame turn left a stale receipt');

  // 3. JSON fallback: server answers the stream request with JSON, UI still updates.
  await page.locator('#ai-prompt').fill('JSONfallback');
  await page.locator('#ai-prompt').press('Enter');
  await page.locator('.ai-bubble-in').filter({hasText: 'Respuesta por JSON'}).last().waitFor();
  assert.equal(await page.locator('#ai-panel .ai-error').count(), 0, 'the JSON fallback was reported as an error');

  // 4. Type the next draft while a stream is running: Enter does not duplicate, draft retained.
  await page.locator('#ai-prompt').fill('Cola');
  await page.locator('#ai-prompt').press('Enter');
  await page.locator('.ai-activity').filter({hasText: 'Pensando'}).waitFor();
  await page.locator('#ai-prompt').fill('Siguiente borrador');
  await page.locator('#ai-prompt').press('Enter');
  assert.equal(requestsFor('Siguiente borrador').length, 0, 'Enter during a live stream dispatched the next draft early');
  assert.equal(await page.locator('#ai-prompt').inputValue(), 'Siguiente borrador', 'the next draft was lost while the agent was streaming');
  releaseGate('cola');
  await page.locator('.ai-bubble-in').filter({hasText: 'Respuesta de Cola'}).last().waitFor();
  assert.equal(await page.locator('#ai-prompt').inputValue(), 'Siguiente borrador', 'the streamed result wiped the next draft');
  await page.locator('#ai-prompt').press('Enter');
  await until(() => requestsFor('Siguiente borrador').length === 1, 'the retained draft to send once the stream finished');
  await page.locator('.ai-bubble-in').filter({hasText: 'Respuesta a Siguiente borrador'}).last().waitFor();

  // 5. Off-screen turn: switch away mid-stream, come back, and the final result still lands.
  await page.locator('#ai-prompt').fill('Pausa');
  await page.locator('#ai-prompt').press('Enter');
  await page.locator('.ai-bubble-out').filter({hasText: 'Pausa'}).waitFor();
  await page.locator('.chat-item').nth(1).click();
  assert.equal(await page.locator('.ai-bubble').count(), 0, 'the pending Pausa turn leaked into another contact');
  assert.equal(await page.locator('.ai-activity').count(), 0, 'the pending receipt leaked into another contact');
  await page.locator('.chat-item').first().click();
  await page.locator('.ai-bubble-out').filter({hasText: 'Pausa'}).waitFor();
  await page.locator('.ai-activity').filter({hasText: 'Pensando'}).waitFor();
  assert.equal(await page.locator('.ai-bubble-out').filter({hasText: 'Pausa'}).count(), 1, 'returning to the contact duplicated the optimistic bubble');
  releaseGate('pausa');
  await page.locator('.ai-bubble-in').filter({hasText: 'Resultado tras cambiar de chat'}).waitFor();
  await until(async () => (await page.locator('.ai-activity').count()) === 0, 'the receipt to clear after the off-screen result', 3000);
  assert.equal(await page.locator('.ai-bubble-in').filter({hasText: 'Resultado tras cambiar de chat'}).count(), 1, 'the off-screen final result was applied twice');

  // 6. SSE error after a delta: incomplete answer + Reintentar reusing one bubble and turnId.
  await page.locator('#ai-prompt').fill('ErrorParcial');
  await page.locator('#ai-prompt').press('Enter');
  await page.locator('#ai-panel .ai-error').filter({hasText: 'Hermes cortó la respuesta'}).waitFor();
  await page.locator('.ai-incomplete').filter({hasText: 'Respuesta incompleta'}).waitFor();
  assert.equal(await page.locator('.ai-activity').count(), 0, 'the receipt stayed after an SSE error');
  assert.equal(await page.locator('.ai-bubble-out').filter({hasText: 'ErrorParcial'}).count(), 1, 'the failed owner bubble duplicated');
  const firstTurnId = requestsFor('ErrorParcial').at(-1).turnId;
  await page.locator('#ai-panel .ai-error button', {hasText: 'Reintentar'}).click();
  await until(() => requestsFor('ErrorParcial').length === 2, 'the retry request');
  assert.equal(requestsFor('ErrorParcial').at(-1).turnId, firstTurnId, 'Reintentar changed the stable turnId');
  await page.locator('.ai-bubble-in').filter({hasText: 'Respuesta a ErrorParcial'}).last().waitFor();
  assert.equal(await page.locator('.ai-bubble-out').filter({hasText: 'ErrorParcial'}).count(), 1, 'the retry created a second owner bubble instead of reusing it');
  assert.equal(await page.locator('.ai-incomplete').count(), 0, 'the completed retry kept the incomplete marker');
  assert.equal(await page.locator('#ai-panel .ai-error').count(), 0, 'the error banner survived the successful retry');
  await shot('live-agent-retry-complete.png');

  // 7. Per-contact isolation: a hidden draft request only touches its own chat.
  await closePanel();
  await page.locator('.chat-item').nth(2).click();
  await page.locator('#suggest').click();
  await until(() => chatRequests.some(entry => entry.key === 'personal:three' && entry.message === DRAFT_INSTRUCTION), 'the hidden draft request for Tres');
  await until(async () => (await page.locator('#suggest').getAttribute('aria-busy')) === 'false', 'Proponer mensaje to finish', 8000);
  const draftEntries = requestsFor(DRAFT_INSTRUCTION);
  assert(draftEntries.length >= 1 && draftEntries.every(entry => entry.key === 'personal:three'), 'the draft request hit the wrong chat');
  assert(draftEntries.every(entry => entry.allowSend === false && entry.allowPropose === true), 'Proponer mensaje did not scope send/proposal grants');

  await openPanel();
  await page.locator('.ai-bubble-out').filter({hasText: DRAFT_LABEL}).first().waitFor();
  const threeText = await page.locator('#ai-panel').innerText();
  assert(threeText.indexOf('Consulta Tres') < threeText.indexOf(DRAFT_LABEL), 'history did not stay before the draft bubble');
  assert.equal(threeText.includes('sin explicaciones ni comillas'), false, 'the raw draft instruction leaked from history');
  await closePanel();

  // 8. Per-account isolation on the secondary account.
  await page.locator('#account').evaluate(select => { select.value = 'secondary'; select.dispatchEvent(new Event('change', {bubbles: true})); });
  await page.locator('.chat-item').first().click();
  await openPanel();
  await page.getByText('Historial secundaria').waitFor();
  assert.equal(await page.getByText('Respuesta previa').count(), 0, 'personal history leaked into the secondary account');
  assert.equal(await page.locator('.ai-bubble-out').filter({hasText: 'Flujo'}).count(), 0, 'a personal-agent turn leaked into the secondary account');
  await closePanel();

  // 9. Mobile 390 viewport: composer grows and the panel fits without overflow.
  await page.locator('#account').evaluate(select => { select.value = 'personal'; select.dispatchEvent(new Event('change', {bubbles: true})); });
  await page.locator('.chat-item').first().click();
  await page.setViewportSize({width: 390, height: 844});
  await openPanel();
  const mobilePanel = await page.locator('#ai-panel').boundingBox();
  assert(mobilePanel && mobilePanel.x >= 0 && mobilePanel.x + mobilePanel.width <= 391, 'the mobile panel overflowed the 390px viewport');
  const beforeGrow = (await page.locator('#ai-prompt').boundingBox()).height;
  await page.locator('#ai-prompt').fill('Un mensaje bastante largo que debe hacer crecer el compositor en varios renglones para comprobar el autoajuste correcto de altura.');
  await until(async () => (await page.locator('#ai-prompt').boundingBox()).height > beforeGrow + 4, 'the composer to grow with the typed draft', 3000);
  const grown = (await page.locator('#ai-prompt').boundingBox()).height;
  assert(grown <= 161, `the composer grew past its 160px cap (got ${grown})`);
  await shot('live-agent-mobile-composer-grow.png');
  assert.equal(await page.locator('#ai-send').isDisabled(), false, 'the send button stayed disabled for a non-empty draft on mobile');
  await closePanel();
  await page.setViewportSize({width: 1280, height: 800});

  assert.equal(sendCount, 0, 'a panel or draft action sent a real WhatsApp message');
  assert.deepEqual(errorsSeen, []);
  console.log(`agent-live-ui: ${chatRequests.length} streamed turns, split-frame + JSON fallback + off-screen hold + SSE-error retry validated, ${sessionCalls.length} session loads, 0 direct sends`);
} finally {
  for (const id of [...gates.keys()]) releaseGate(id);
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
