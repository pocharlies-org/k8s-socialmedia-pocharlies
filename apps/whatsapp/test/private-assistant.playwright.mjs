#!/usr/bin/env node
/*
 * Social Media Agent conversation contract: the right panel is an ordinary chat,
 * the composer keeps a "Proponer mensaje" action next to "+", and no panel surface
 * may send a WhatsApp message that the owner did not send or approve.
 *
 * Stream contract: every /api/ai/chat request must carry stream=true and a stable
 * turnId UUID, and the UI must also work when the server keeps answering with JSON.
 * A slow turn keeps an optimistic owner bubble, clears the composer immediately,
 * shows a temporary typing receipt, lets the owner type the next draft, and a
 * failed turn leaves the bubble plus an explicit Reintentar action that reuses it.
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
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const filename = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!filename.startsWith(`${publicDir}${path.sep}`)) return response.writeHead(403).end();
  try {
    const body = await readFile(filename);
    response.writeHead(200, {'content-type': {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'}[path.extname(filename)] || 'application/octet-stream'}).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome'});
const page = await browser.newPage();

const chats = {personal: [{id: 'one', name: 'Uno'}, {id: 'two', name: 'Dos'}, {id: 'three', name: 'Tres'}], secondary: [{id: 'one', name: 'Uno secundario'}]};
const sessions = new Map([
  ['personal:one', {sessionId: 'session-personal-one', messages: [{role: 'user', content: 'Consulta previa'}, {role: 'assistant', content: 'Respuesta previa'}]}],
  ['personal:three', {sessionId: 'session-personal-three', messages: [{role: 'user', content: DRAFT_INSTRUCTION}, {role: 'assistant', content: 'Respuesta Tres previa'}]}]
]);
const proposals = new Map([
  ['personal:one', [{id: 'proposal-approve', text: 'Texto exacto para enviar', expiresAt: '2099-01-01T00:00:00Z'}, {id: 'proposal-reject', text: 'Texto que no se enviará', expiresAt: '2099-01-01T00:00:00Z'}]],
  ['personal:three', [{id: 'proposal-base-three', text: 'Propuesta base de Tres', expiresAt: '2099-01-01T00:00:00Z'}]]
]);
const turns = [];
const decisions = [];
const errors = [];
const sessionCalls = [];
const sessionDoneAt = new Map();
const chatLog = [];
const sessionDelays = new Map([['personal:three', 450]]);
let sendingEnabled = true;
let directSends = 0;
let reply = 'Respuesta del agente';
let failNext = false;
let holdNext = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, label, timeout = 12000) => {
  const start = Date.now();
  for (;;) {
    if (await condition()) return true;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${label}`);
    await sleep(25);
  }
};
const keySessionCalls = key => sessionCalls.filter(call => call === key).length;
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
  const account = url.searchParams.get('account') || body?.account;
  const chat = url.searchParams.get('chat') || body?.chat;
  const key = `${account}:${chat}`;
  const json = payload => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(payload)});
  if (url.pathname === '/api/accounts') return json({accounts: [{id: 'personal', label: 'Personal'}, {id: 'secondary', label: 'Secundaria'}], sendingEnabled});
  if (url.pathname === '/api/chats') return json({chats: chats[account] || []});
  if (url.pathname === '/api/messages') return json({messages: []});
  if (url.pathname === '/api/send') { directSends++; return json({messageId: 'wa-confirmed'}); }
  if (url.pathname === '/api/ai/session') {
    sessionCalls.push(key);
    await sleep(sessionDelays.get(key) || 0);
    sessionDoneAt.set(key, Date.now());
    const stored = sessions.get(key) || {sessionId: `session-${key}`, messages: []};
    return json({sessionId: stored.sessionId, messages: stored.messages});
  }
  if (url.pathname === '/api/ai/proposals') return json({proposals: (proposals.get(key) || []).map(proposal => ({...proposal}))});
  if (url.pathname === '/api/ai/proposal') {
    decisions.push(body);
    proposals.set(key, (proposals.get(key) || []).filter(proposal => proposal.id !== body.id));
    if (body.id === 'proposal-uncertain') return route.fulfill({status: 502, contentType: 'application/json', body: JSON.stringify({code: 'DELIVERY_UNCONFIRMED', error: 'Estado de entrega desconocido; no reintentar automáticamente'})});
    return json(body.action === 'approve' ? {confirmed: true, messageId: 'wa-confirmed'} : {rejected: true});
  }
  if (url.pathname === '/api/ai/chat') {
    assert.equal(body.stream, true, 'the web UI stopped requesting streamed agent answers');
    assert.equal(typeof body.allowPropose, 'boolean', 'the web UI omitted the proposal grant state');
    assert.equal(typeof body.allowSend, 'boolean', 'the web UI omitted the direct-send grant state');
    assert.match(String(body.turnId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'the web UI sent a non-UUID turnId');
    assert.equal(body.requestId, undefined, 'the browser must not assign direct-send request IDs');
    turns.push({key, message: body.message, allowPropose: body.allowPropose, allowSend: body.allowSend, turnId: body.turnId});
    chatLog.push({key, at: Date.now()});
    if (holdNext && !holdNext.route) { holdNext.route = route; return; }
    if (failNext) { failNext = false; return route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'Hermes no disponible'})}); }
    const stored = sessions.get(key) || {sessionId: `session-${key}`, messages: []};
    stored.messages.push({role: 'user', content: body.message}, {role: 'assistant', content: reply});
    sessions.set(key, stored);
    if (key === 'personal:three' && body.message === DRAFT_INSTRUCTION) proposals.get('personal:three').push({id: 'proposal-during-turn', text: 'Propuesta creada durante el turno', expiresAt: '2099-01-01T00:00:00Z'});
    return json({sessionId: stored.sessionId, text: reply});
  }
  return json({});
});
const openPanel = async () => { if (await page.locator('#ai-panel').isHidden()) await page.locator('#ai-toggle').click(); await page.locator('#ai-panel').waitFor({state: 'visible'}); };
const closePanel = async () => { if (await page.locator('#ai-panel').isVisible()) await page.locator('#ai-close').click(); await page.locator('#ai-panel').waitFor({state: 'hidden'}); };
const settleTurn = async (outcome = 'ok') => {
  if (holdNext) {
    await until(() => holdNext?.route, 'held agent request to reach the mock server');
    const {route} = holdNext; holdNext = null;
    if (outcome === 'fail') await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'Hermes no disponible'})});
    else {
      const stored = sessions.get(lastTurnKey()) || {sessionId: 'chat', messages: []};
      stored.messages.push({role: 'user', content: turns.at(-1).message}, {role: 'assistant', content: reply});
      sessions.set(lastTurnKey(), stored);
      await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({sessionId: stored.sessionId, text: reply})});
    }
  }
  await page.waitForFunction(() => document.querySelector('#suggest')?.classList.contains('is-busy') === false && document.querySelector('#suggest')?.getAttribute('aria-busy') === 'false');
};
const lastTurnKey = () => turns.at(-1)?.key;
const draftTurns = key => turns.filter(turn => turn.key === key && turn.message === DRAFT_INSTRUCTION && turn.allowPropose).length;
const shot = async name => { try { await mkdir(shotsDir, {recursive: true}); await page.screenshot({path: path.join(shotsDir, name)}); } catch { /* evidence only */ } };

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('.chat-item').first().click();
  assert.equal(await page.locator('#ai-panel').isVisible(), false, 'the panel opened by itself');
  assert.equal(sessionCalls.length, 0, 'a hidden panel loaded an agent session');
  assert.equal(await page.locator('#ai-panel-subtitle').textContent(), 'Uno', 'the panel did not name the open chat');
  assert.equal(await page.locator('#suggest').isEnabled(), true, 'Proponer mensaje was disabled for an open chat');

  await openPanel();
  await page.locator('.ai-bubble-in').first().waitFor();
  assert(keySessionCalls('personal:one') > 0, 'opening the panel did not load session state');
  assert(await until(async () => (await page.locator('.ai-proposal').count()) === 2, 'the panel to load pending proposals'), 'opening the panel did not load proposals');
  assert.equal((await page.locator('#ai-panel-title').textContent()).trim(), 'Social Media Agent', 'the panel is not titled Social Media Agent');
  assert.equal(await page.locator('#ai-panel[aria-label="Social Media Agent"]').count(), 1, 'the panel is not labelled as the agent');
  const panelText = await page.locator('#ai-panel').innerText();
  for (const legacy of ['Asistente privado', 'SOLO PARA TI', 'Permitir proponer']) {
    assert.equal(panelText.includes(legacy), false, `the panel still shows "${legacy}"`);
  }
  assert.equal(await page.locator('#ai-panel input, #ai-panel select, #ai-panel output').count(), 0, 'the panel exposes configuration controls');
  assert.equal(await page.locator('#ai-allow-propose').count(), 0, 'the proposal permission checkbox is still mounted');
  assert.equal(await page.locator('.ai-bubble-in').first().innerText(), 'Respuesta previa', 'the agent reply did not render as an incoming bubble');
  assert.equal(await page.locator('.ai-bubble-out').first().innerText(), 'Consulta previa', 'the owner turn did not render as an outgoing bubble');

  await page.locator('.chat-item').nth(1).click();
  await page.getByText('Escribe para consultar sobre esta conversación.').waitFor();
  assert.equal(await page.locator('.ai-bubble').count(), 0, 'bubbles leaked between chats');

  // Held turn: optimistic bubble, cleared composer, temporary receipt, and the
  // owner can leave/return or type the next draft without losing anything.
  reply = 'Le piden confirmar la reunión del jueves';
  holdNext = {};
  await page.locator('.chat-item').first().click();
  await page.locator('#ai-prompt').waitFor();
  await page.locator('#ai-prompt').fill('Resume el chat');
  await page.locator('#ai-prompt').press('Enter');
  await page.locator('.ai-bubble-out').filter({hasText: 'Resume el chat'}).waitFor();
  assert.equal(await page.locator('#ai-prompt').inputValue(), '', 'the composer kept the sent text instead of clearing optimistically');
  await page.locator('.ai-activity').filter({hasText: 'Pensando'}).waitFor();
  assert.equal(await page.locator('#ai-send').isDisabled(), true, 'the panel stayed enabled while the agent was answering');
  assert.equal(await page.locator('.ai-typing').count(), 1, 'the typing receipt is not part of the activity row');

  await page.locator('.chat-item').nth(1).click();
  await page.getByText('Escribe para consultar sobre esta conversación.').waitFor();
  assert.equal(await page.locator('.ai-bubble').count(), 0, 'a pending turn leaked into another contact');
  assert.equal(await page.locator('.ai-activity').count(), 0, 'the pending receipt leaked into another contact');
  await page.locator('.chat-item').first().click();
  await page.locator('.ai-bubble-out').filter({hasText: 'Resume el chat'}).waitFor();
  await page.locator('.ai-activity').filter({hasText: 'Pensando'}).waitFor();

  await page.locator('#ai-prompt').fill('Borrador siguiente');
  await page.locator('#ai-prompt').press('Enter');
  assert.equal(await page.locator('#ai-prompt').inputValue(), 'Borrador siguiente', 'Enter during a pending turn discarded the next draft');
  assert.equal(turns.filter(turn => turn.message === 'Borrador siguiente').length, 0, 'Enter during a pending turn duplicated the request');
  await settleTurn();
  await page.locator('.ai-bubble-in').filter({hasText: reply}).last().waitFor();
  assert.equal(await page.locator('.ai-activity').count(), 0, 'the typing receipt stayed after the answer');
  assert.equal(await page.locator('#ai-prompt').inputValue(), 'Borrador siguiente', 'the answer wiped the draft typed while the agent was working');
  assert.equal(turns.at(-1).allowPropose, true, 'the authenticated owner turn lacks proposal access');
  assert.equal(turns.at(-1).allowSend, true, 'the authenticated owner turn lacks direct-send access');

  reply = 'Respuesta con **énfasis**';
  await page.locator('#ai-prompt').press('Enter');
  await until(() => turns.some(turn => turn.message === 'Borrador siguiente'), 'the retained draft to be sent after the previous turn');
  await page.locator('.ai-bubble-in').filter({hasText: 'énfasis'}).last().waitFor();
  assert.equal(await page.locator('.ai-bubble-in strong').last().textContent(), 'énfasis', 'agent replies are not rendered as Markdown');
  assert.equal((await page.locator('.ai-bubble-in').last().innerText()).includes('**'), false, 'raw Markdown leaked into an agent reply');
  assert.equal(await page.locator('#ai-prompt').inputValue(), '', 'the second send left text in the composer');

  // Failed turn: owner bubble stays, composer stays clear, and Reintentar reuses
  // the same bubble and turnId instead of assigning a fresh one.
  holdNext = {};
  await page.locator('#ai-prompt').fill('Envía este mensaje');
  await page.locator('#ai-prompt').press('Enter');
  await page.locator('.ai-bubble-out').filter({hasText: 'Envía este mensaje'}).waitFor();
  assert.equal(await page.locator('#ai-prompt').inputValue(), '', 'a failing turn left the composer populated instead of optimistic');
  await settleTurn('fail');
  await page.locator('#ai-panel .ai-error').filter({hasText: 'Hermes no disponible'}).waitFor();
  assert.equal(await page.locator('.ai-activity').count(), 0, 'the typing receipt stayed after an error');
  assert.equal(await page.locator('.ai-incomplete').count(), 0, 'a turn without partial text claimed an incomplete answer');
  assert.equal(await page.locator('.ai-bubble-out').filter({hasText: 'Envía este mensaje'}).count(), 1, 'the failed owner bubble disappeared or duplicated');
  const turnIdBefore = turns.filter(turn => turn.message === 'Envía este mensaje').at(-1).turnId;
  holdNext = {};
  await page.locator('#ai-panel .ai-error button', {hasText: 'Reintentar'}).dblclick();
  await until(() => turns.filter(turn => turn.message === 'Envía este mensaje').length === 2, 'the retry request');
  await sleep(200);
  assert.equal(turns.filter(turn => turn.message === 'Envía este mensaje').length, 2, 'Reintentar sent the turn twice (missing double-submit guard)');
  assert.equal(turns.filter(turn => turn.message === 'Envía este mensaje').at(-1).turnId, turnIdBefore, 'Reintentar lost the stable turnId of the failed turn');
  await settleTurn();
  await page.locator('.ai-bubble-in').filter({hasText: 'Respuesta con'}).last().waitFor();
  assert.equal(await page.locator('.ai-bubble-out').filter({hasText: 'Envía este mensaje'}).count(), 1, 'Reintentar duplicated the owner bubble instead of reusing it');
  assert.equal(await page.locator('#ai-panel .ai-error').count(), 0, 'the error banner survived a successful retry');
  await shot('private-agent-desktop-response.png');

  await page.locator('#ai-prompt').fill(DRAFT_INSTRUCTION);
  await page.locator('#ai-prompt').press('Enter');
  await page.locator('.ai-bubble-out').filter({hasText: DRAFT_LABEL}).last().waitFor();
  assert(await until(() => { const turn = turns.filter(t => t.message === DRAFT_INSTRUCTION).at(-1); return Boolean(turn) && turn.allowPropose === true; }, 'the draft instruction turn'), 'the authenticated owner instruction lacks proposal access');
  assert.equal(directSends, 0, 'an ordinary chat turn sent a WhatsApp message');

  await page.locator('#ai-use-draft').click();
  assert.equal(await page.locator('#message').inputValue(), reply, 'the draft action did not fill the composer');
  assert.equal(await page.locator('#ai-panel').isVisible(), false, 'using the draft left the panel open');
  assert.equal(directSends, 0, 'a draft action sent a WhatsApp message');

  await page.locator('#message').fill('');
  holdNext = {};
  const draftTurnsBefore = draftTurns('personal:one');
  await page.locator('#suggest').click();
  await page.locator('#suggest.is-busy').waitFor({state: 'visible'});
  assert.equal(await page.locator('#suggest').getAttribute('aria-busy'), 'true', 'Proponer mensaje did not report progress');
  assert.equal(await page.locator('#suggest').isDisabled(), true, 'Proponer mensaje could be clicked twice');
  assert.equal(await page.locator('#message').inputValue(), '', 'the draft arrived before the answer');
  await settleTurn();
  await until(() => draftTurns('personal:one') === draftTurnsBefore + 1, 'Proponer mensaje to ask the session once');
  assert.deepEqual(turns.filter(turn => turn.key === 'personal:one').at(-1), {key: 'personal:one', message: DRAFT_INSTRUCTION, allowPropose: true, allowSend: false, turnId: turns.filter(turn => turn.key === 'personal:one').at(-1).turnId}, 'Proponer mensaje asked another chat or requested direct sending');
  assert.equal(await page.locator('#message').inputValue(), reply, 'the proposal was not written as a draft');
  assert.equal(directSends, 0, 'Proponer mensaje sent a WhatsApp message');
  assert.equal(await page.locator('#ai-panel').isVisible(), false, 'Proponer mensaje opened the panel');

  reply = '  "Voy para allí en 10 minutos."  ';
  const draftInProgress = await page.locator('#message').inputValue();
  assert(draftInProgress.length > 0, 'no draft was in progress to preserve');
  await page.locator('#suggest').click();
  await settleTurn();
  assert.equal(await page.locator('#message').inputValue(), `${draftInProgress}\n\nVoy para allí en 10 minutos.`, 'the proposal was not cleaned or replaced the draft in progress');

  reply = '```text\nReunión a las 9 confirmada\n```';
  await page.locator('#message').fill('');
  await page.locator('#suggest').click();
  await settleTurn();
  assert.equal(await page.locator('#message').inputValue(), 'Reunión a las 9 confirmada', 'a fenced proposal was not unwrapped for an empty draft');

  await openPanel();
  await page.locator('.ai-bubble-out').filter({hasText: 'Propón un mensaje para responder'}).first().waitFor();
  await closePanel();

  const draftBefore = await page.locator('#message').inputValue();
  failNext = true;
  await page.locator('#suggest').click();
  await page.locator('#error').filter({hasText: 'Hermes no disponible'}).waitFor();
  await settleTurn();
  assert.equal(await page.locator('#message').inputValue(), draftBefore, 'a failed proposal changed the draft');
  assert.equal(await page.locator('#suggest').isDisabled(), false, 'Proponer mensaje stayed disabled after failing');

  reply = 'Respuesta para Dos';
  await page.locator('.chat-item').nth(1).click();
  await page.locator('#message').fill('Borrador de Dos');
  holdNext = {};
  await page.locator('#suggest').click();
  await page.locator('#suggest.is-busy').waitFor({state: 'visible'});
  await page.locator('.chat-item').first().click();
  const oneDraft = await page.locator('#message').inputValue();
  assert(!oneDraft.includes('Respuesta para Dos'), 'the pending proposal leaked before its answer arrived');
  await settleTurn();
  await page.waitForTimeout(120);
  assert.equal(await page.locator('#message').inputValue(), oneDraft, 'a late proposal was written into another chat');
  await page.locator('.chat-item').nth(1).click();
  assert.equal(await page.locator('#message').inputValue(), 'Borrador de Dos', 'the draft of the other chat was lost');

  // Chat Tres exercises the history race: slow history shared by a hidden draft
  // request and a panel opened or reopened while that load is still in flight.
  await closePanel();
  await page.locator('.chat-item').nth(2).click();
  const threeBaseline = keySessionCalls('personal:three');
  await openPanel();
  await page.getByText('Cargando conversación…').waitFor();
  await closePanel();
  await openPanel();
  await page.locator('.ai-bubble-in').filter({hasText: 'Respuesta Tres previa'}).waitFor();
  assert.equal(keySessionCalls('personal:three'), threeBaseline + 1, 'close/reopen during pending history re-issued the session load');
  assert.equal(await page.locator('.ai-bubble-in').filter({hasText: 'Respuesta Tres previa'}).count(), 1, 'history duplicated after reopening during load');
  assert.equal(await page.locator('.ai-bubble-out').filter({hasText: DRAFT_LABEL}).count(), 1, 'a stored draft instruction did not render as its short label');
  assert.equal((await page.locator('#ai-panel').innerText()).includes('sin explicaciones ni comillas'), false, 'the raw draft instruction leaked from history');
  await closePanel();

  await page.reload();
  await page.locator('.chat-item').nth(2).click();
  const askSessionBaseline = keySessionCalls('personal:three');
  const askTurnBaseline = turns.filter(turn => turn.key === 'personal:three').length;
  reply = 'Propuesta específica de Tres';
  await page.locator('#suggest').click();
  await page.locator('#suggest.is-busy').waitFor({state: 'visible'});
  assert(await until(async () => (await page.locator('#ai-panel .ai-bubble-out').filter({hasText: DRAFT_LABEL}).count()) >= 1, 'the hidden draft optimistic bubble', 3000), 'the hidden draft request did not add its optimistic bubble');
  await sleep(150);
  assert.equal(keySessionCalls('personal:three'), askSessionBaseline + 1, 'the hidden draft request did not start exactly one history load');
  assert.equal(turns.filter(turn => turn.key === 'personal:three').length, askTurnBaseline, 'the chat request raced ahead of the pending history load');
  await until(() => turns.filter(turn => turn.key === 'personal:three').length === askTurnBaseline + 1, 'the chat request after the slow history load');
  assert.equal(turns.filter(turn => turn.key === 'personal:three').at(-1).allowSend, false, 'Proponer mensaje allowed direct sending from a hidden chat');
  const threeSessionDone = sessionDoneAt.get('personal:three') || 0;
  const threeChatAt = chatLog.filter(entry => entry.key === 'personal:three').at(-1).at;
  assert(threeChatAt >= threeSessionDone - 2, 'the draft chat request bypassed the awaited history load');
  await openPanel();
  assert(await until(() => keySessionCalls('personal:three') === askSessionBaseline + 2, 'the panel opening to refresh history once'), 'opening the panel re-issued the history load more than once');
  assert(await until(async () => (await page.locator('.ai-proposal').filter({hasText: 'Propuesta creada durante el turno'}).count()) === 1, 'the mid-turn proposal refresh'), 'opening a hidden panel mid-turn did not refresh proposals on result');
  const threadText = await page.locator('#ai-panel').innerText();
  assert(threadText.indexOf(DRAFT_LABEL) < threadText.indexOf('Respuesta Tres previa'), 'history did not merge before the optimistic bubble');
  assert(threadText.indexOf('Respuesta Tres previa') < threadText.indexOf('Propuesta específica de Tres'), 'the draft answer did not land after the merged history');
  assert.equal((await page.locator('.ai-bubble-out').filter({hasText: DRAFT_LABEL}).count()), 2, 'the draft instruction bubble count changed across history refresh');
  assert.equal(threadText.includes('sin explicaciones ni comillas'), false, 'the raw draft instruction leaked from the merged history');
  assert.equal(directSends, 0, 'the hidden draft request sent a WhatsApp message');
  await closePanel();

  await page.locator('.chat-item').first().click();
  await openPanel();
  await page.locator('.ai-proposal').filter({hasText: 'Texto exacto para enviar'}).waitFor();
  await page.locator('.ai-proposal').filter({hasText: 'Texto exacto para enviar'}).getByRole('button', {name: 'Aprobar y enviar'}).click();
  await page.locator('.ai-proposal').filter({hasText: 'Texto exacto para enviar'}).waitFor({state: 'detached'});
  assert.deepEqual(decisions[0], {account: 'personal', chat: 'one', id: 'proposal-approve', action: 'approve'});
  await page.locator('.ai-proposal').filter({hasText: 'Texto que no se enviará'}).getByRole('button', {name: 'Descartar'}).click();
  assert.deepEqual(decisions[1].id, 'proposal-reject');
  assert.equal(decisions[1].action, 'reject');
  proposals.get('personal:one').push({id: 'proposal-uncertain', text: 'Texto con entrega incierta', expiresAt: '2099-01-01T00:00:00Z'});
  await closePanel();
  await openPanel();
  await page.locator('.ai-proposal').filter({hasText: 'Texto con entrega incierta'}).getByRole('button', {name: 'Aprobar y enviar'}).click();
  await page.locator('#ai-panel .ai-error').filter({hasText: 'Estado de entrega desconocido'}).waitFor();
  await page.locator('.ai-proposal').filter({hasText: 'Texto con entrega incierta'}).waitFor({state: 'detached'});
  assert.equal(decisions.filter(decision => decision.id === 'proposal-uncertain').length, 1, 'an uncertain delivery was retried');
  assert.equal(proposals.get('personal:one').length, 0, 'a consumed proposal stayed pending');
  assert.equal(await page.locator('.ai-proposal').filter({hasText: 'Propuesta creada durante el turno'}).count(), 0, 'a proposal from another chat leaked here');
  await closePanel();

  await page.locator('#account').evaluate(select => { select.value = 'secondary'; select.dispatchEvent(new Event('change', {bubbles: true})); });
  await page.locator('.chat-item').first().click();
  await openPanel();
  await page.getByText('Escribe para consultar sobre esta conversación.').waitFor();
  assert.equal(await page.getByText('Respuesta previa').count(), 0, 'history leaked across accounts');
  assert.equal(await page.locator('.ai-proposal').count(), 0, 'proposals leaked into another account');
  await closePanel();

  await page.setViewportSize({width: 390, height: 844});
  await openPanel();
  await page.locator('#ai-prompt').waitFor({state: 'visible'});
  const panel = await page.locator('#ai-panel').boundingBox();
  assert(panel && panel.x >= 0 && panel.x + panel.width <= 391, 'the panel overflowed the mobile viewport');
  await shot('private-agent-mobile-panel.png');
  await closePanel();
  await page.setViewportSize({width: 1280, height: 800});

  sendingEnabled = false;
  await page.reload();
  await page.locator('.chat-item').first().click();
  assert.equal(await page.locator('#send').isDisabled(), true, 'sending stayed enabled without the server gate');
  assert.equal(await page.locator('#suggest').isEnabled(), true, 'Proponer mensaje requires the send gate to draft a message');
  assert.equal(directSends, 0, 'a draft was sent to WhatsApp without the owner');

  assert.deepEqual(errors, []);
  console.log(`private-assistant: ${turns.length} agent turns validated, ${sessionCalls.length} session loads, 0 direct sends`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
