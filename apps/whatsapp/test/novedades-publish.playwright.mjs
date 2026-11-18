#!/usr/bin/env node
/*
 * Contrato de navegador del compositor de estados de Novedades: la audiencia es
 * siempre explícita (nunca "toda la agenda") y se confirma antes de enviar; los
 * límites de 10 MiB y de formato se frenan antes de leer el archivo; un fallo
 * cierto o incierto deja el borrador intacto y sin reintento automático; y una
 * cuenta que cambia a mitad del envío no puede borrar el borrador actual ni
 * reclamar como propio el éxito de la cuenta anterior. Nada de esto publica de
 * verdad: la ruta /api/novedades/status es un fixture controlado.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

let sendingEnabled = true;
let publishMode = 'confirmed';
let publishGate = null;
const sent = [];
const contactCalls = [];
const pageErrors = [];
let authorsCalls = 0;
// Cada recarga de la lista de estados durante un envío en curso sería una
// señal de que la vista del editor se está moviendo por detrás del aviso.
const statusReads = [];

const directory = [
  { key: '34600111222', label: 'Ana Ruiz', sublabel: '+34600111222', kind: 'chat', chatId: '34600111222@s.whatsapp.net', phone: '+34600111222', avatarUrl: null, hasChat: true, archived: false, canOpen: true, canStart: false },
  { key: 'lid:987654321', label: 'ID privado', sublabel: 'LID ···321', kind: 'private', chatId: null, phone: null, avatarUrl: null, hasChat: false, archived: false, canOpen: false, canStart: false },
  { key: '34600999888', label: 'Sofía Vega', sublabel: '+34600999888', kind: 'chat', chatId: '34600999888@s.whatsapp.net', phone: '+34600999888', avatarUrl: null, hasChat: true, archived: false, canOpen: true, canStart: false },
  // Sincronizado pero sin JID alcanzable: se muestra, no se puede elegir.
  { key: 'ext:222', label: 'Marcos Sin Nº', sublabel: 'Sin teléfono sincronizado', kind: 'contact', chatId: null, phone: null, avatarUrl: null, hasChat: false, archived: false, canOpen: false, canStart: false },
];

const waitUntil = async (predicate, label) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 20000) throw new Error(`sin evidencia: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.local');
  const json = (status, data) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));

  if (url.pathname === '/api/novedades/status' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => {
      const payload = JSON.parse(body || '{}');
      sent.push(payload);
      if (publishMode === 'slow' && publishGate) await publishGate;
      if (publishMode === 'reject') return json(400, { error: 'El destinatario no existe en WhatsApp.', code: 'INVALID_RECIPIENT' });
      // Como responde el proxy real: un 5xx con el flag que corta cualquier
      // lectura optimista del código. app.js lo copia en la excepción.
      if (publishMode === 'uncertain') return json(502, { error: 'Estado de entrega desconocido; el estado puede haberse publicado. No reintentar automáticamente.', code: 'DELIVERY_UNCONFIRMED', outcomeUncertain: true, details: { reason: 'connector_unreachable' } });
      // El mismo 502 etiquetado como rechazo: el status pesa más que la etiqueta.
      if (publishMode === 'refused5xx') return json(502, { error: 'WhatsApp connector refused the status publish (HTTP 502)', code: 'STATUS_PUBLISH_REJECTED' });
      // Rechazo antes de despachar: nunca salió petición, aunque el status sea 5xx.
      if (publishMode === 'credentials') return json(503, { error: 'Connector credentials unavailable' });
      if (publishMode === 'unconfirmed') return json(200, { account: payload.account, confirmed: true, type: payload.type, recipients: payload.recipients });
      return json(200, { account: payload.account, confirmed: true, type: payload.type, recipients: payload.recipients, messageId: 'MSG-1' });
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/accounts') return json(200, { accounts: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }], sendingEnabled });
    if (url.pathname === '/api/chats') return json(200, { chats: [], hasMore: false, nextCursor: null });
    if (url.pathname === '/api/novedades/status/authors') {
      authorsCalls += 1;
      return json(200, {
        account: url.searchParams.get('account'),
        hasMore: false,
        nextCursor: null,
        coverage: {},
        authors: [{ id: '34600333444@s.whatsapp.net', name: 'Marta Ríos', own: false, count: 2, unseen: 1, latestTimestamp: new Date().toISOString() }],
      });
    }
    if (url.pathname === '/api/novedades/status' && request.method === 'GET') {
      statusReads.push(url.searchParams.get('account'));
      return json(200, { account: url.searchParams.get('account'), items: [], hasMore: false, nextCursor: null });
    }
    if (url.pathname === '/api/contacts') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const cursor = url.searchParams.get('cursor');
      contactCalls.push({ q, cursor, account: url.searchParams.get('account'), limit: url.searchParams.get('limit') });
      const pool = directory.filter(item => !q || item.label.toLowerCase().includes(q) || (item.phone || '').includes(q));
      const page = cursor === 'p2' ? pool.slice(3) : pool.slice(0, 3);
      return json(200, {
        account: url.searchParams.get('account'),
        contacts: page,
        nextCursor: cursor !== 'p2' && pool.length > 3 ? 'p2' : null,
        total: pool.length,
        sendingEnabled,
      });
    }
    return json(200, {});
  }

  const file = path.resolve(publicDir, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(`${publicDir}${path.sep}`)) { response.writeHead(403).end(); return; }
  readFile(file).then(body => {
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)];
    response.writeHead(200, { 'content-type': type || 'application/octet-stream' }).end(body);
  }).catch(() => response.writeHead(404).end());
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin);
  await page.locator('[data-account-id="alpha"]').waitFor();

  const openPanel = async () => {
    await page.getByRole('button', { name: 'Estados', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.novedades-panel')?.getAttribute('aria-busy') === 'false');
  };
  const openComposer = async () => {
    await page.getByRole('button', { name: 'Publicar un estado nuevo' }).click();
    await page.locator('.novedades-composer').waitFor();
  };
  const composer = page.locator('.novedades-composer');
  const chips = composer.locator('.novedades-chip');
  const rows = composer.locator('.novedades-audience-row');
  const errorLine = composer.locator('.novedades-composer-error');
  const review = composer.locator('.novedades-review');
  const dialog = page.locator('.novedades-confirm-dialog');

  // The request is recorded when it arrives at the fixture, so every transition
  // is waited on the page side: the DOM has to show the consequence first.
  // Under a loaded machine the browser needs longer than a quiet one: these are
  // harness ceilings, not product claims, and a broken UI still fails the wait.
  const uiSettled = (pageFunction, label) => page.waitForFunction(pageFunction, null, { timeout: 25000 })
    .catch(error => { throw new Error(`${label}: ${String(error.message).split('\n')[0]}`); });
  const composerGone = label => uiSettled(() => !document.querySelector('.novedades-composer'), label);

  await openPanel();
  assert(await page.getByRole('button', { name: 'Publicar un estado nuevo' }).isVisible(), 'the composer entry is offered when sending is enabled');
  await openComposer();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'novedades-status-text', 'the composer opens on the text field');

  await review.click();
  assert.match(await errorLine.textContent(), /Elige al menos un destinatario/u);
  assert.equal(sent.length, 0, 'an empty audience never reaches the status route');
  assert.equal(await page.locator('.novedades-confirm-dialog').count(), 0, 'nothing to confirm without a recipient');

  await composer.locator('#novedades-status-text').fill('Buenas noches');
  assert.equal(await composer.locator('.novedades-text-counter').textContent(), '13/700');

  const anaSearch = page.waitForRequest(request => request.url().includes('/api/contacts') && request.url().includes('q=ana'));
  await composer.getByLabel('Buscar contactos para el estado').fill('ana');
  await anaSearch;
  assert.equal(await rows.count(), 1, 'the directory search narrows the audience list');
  await rows.first().locator('input[type="checkbox"]').check();
  assert.equal(await chips.count(), 1);
  assert.match(await chips.first().textContent(), /Ana Ruiz · \+34600111222/u);

  await composer.getByLabel('Buscar contactos para el estado').fill('');
  await page.waitForFunction(() => document.querySelectorAll('.novedades-audience-row').length === 3);
  await rows.nth(1).locator('input[type="checkbox"]').check();
  assert.match(await chips.nth(1).textContent(), /ID privado ···321/u, 'a private identifier is chosen and shown as what it is');

  const moreCall = page.waitForRequest(request => request.url().includes('cursor=p2'));
  await composer.getByRole('button', { name: 'Cargar más contactos' }).click();
  await moreCall;
  await page.waitForFunction(() => document.querySelectorAll('.novedades-audience-row').length === 4);
  await rows.nth(2).locator('input[type="checkbox"]').check();
  assert.match(await composer.locator('.novedades-audience-count').textContent(), /3 destinatarios elegidos/u);

  // A synced contact without a reachable JID is shown as what it is: readable,
  // explained, and impossible to pick.
  const brokenRow = rows.nth(3);
  assert.equal(await brokenRow.evaluate(node => node.classList.contains('is-disabled')), true, 'un contacto sin JID se pinta como no elegible');
  assert.equal(await brokenRow.getAttribute('aria-disabled'), 'true', 'y se anuncia como no elegible');
  assert.equal(await brokenRow.locator('input[type="checkbox"]').isDisabled(), true, 'su casilla no se puede marcar');
  assert.match(await brokenRow.textContent(), /Sin número ni identificador privado utilizable/u, 'la fila explica por qué no vale');
  await brokenRow.evaluate(node => node.querySelector('input[type="checkbox"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  assert.equal(await chips.count(), 3, 'un contacto no elegible nunca se cuela entre los destinatarios');

  await composer.getByRole('button', { name: 'Quitar a Sofía Vega de los destinatarios' }).click();
  assert.equal(await chips.count(), 2, 'a chip can be taken back');
  assert.equal(await rows.nth(2).locator('input[type="checkbox"]').isChecked(), false, 'the row follows the chip back');
  await rows.nth(2).locator('input[type="checkbox"]').check();
  assert.equal(await chips.count(), 3);

  await composer.locator('.novedades-swatch input').nth(2).check();
  await composer.locator('.novedades-font-option input').nth(3).check();
  const previewStyle = await composer.locator('.novedades-preview-text').evaluate(node => ({ background: getComputedStyle(node).backgroundColor, weight: getComputedStyle(node).fontWeight }));
  assert.equal(previewStyle.background, 'rgb(59, 21, 53)', 'the chosen colour paints the preview');
  assert.equal(previewStyle.weight, '700', 'the chosen font weight shows in the preview');

  await review.click();
  assert.equal(await dialog.getAttribute('role'), 'alertdialog');
  assert.equal(await dialog.getAttribute('aria-modal'), 'true');
  assert.equal(await dialog.locator('li').count(), 3);
  assert.match(await dialog.textContent(), /Ana Ruiz · \+34600111222/u);
  assert.match(await dialog.textContent(), /ID privado ···321/u);
  assert.equal(sent.length, 0, 'the summary step is mandatory before anything is sent');

  const refreshesBefore = authorsCalls;
  await composer.locator('.novedades-confirm-send').click();
  await composerGone('el estado confirmado cierra el editor');
  await waitUntil(() => sent.length === 1, 'first publish request');
  const textPayload = sent[0];
  assert.equal(textPayload.type, 'text');
  assert.equal(textPayload.text, 'Buenas noches');
  assert.deepEqual(textPayload.recipients, ['34600111222@s.whatsapp.net', '987654321@lid', '34600999888@s.whatsapp.net']);
  assert.equal(textPayload.backgroundColor, '#3b1535');
  assert.equal(textPayload.font, 4);
  assert.equal(textPayload.account, 'alpha');
  assert.equal(Object.hasOwn(textPayload, 'data'), false);
  assert.equal(Object.hasOwn(textPayload, 'mimeType'), false);
  assert.equal(await page.locator('.novedades-composer-error').count(), 0, 'a confirmed send leaves no error behind');
  await uiSettled(() => /Estado publicado/u.test(document.querySelector('.novedades-status')?.textContent || ''), 'the confirmation reaches the status line');
  await waitUntil(() => authorsCalls > refreshesBefore, 'the list refreshes after a published status');
  assert.match(await page.locator('.novedades-status').textContent(), /Estado publicado/u, 'the refresh after publishing cannot erase the confirmation');

  await openComposer();
  assert.equal(await composer.locator('#novedades-status-text').inputValue(), '', 'the draft is only cleared once the send is confirmed');
  assert.match(await composer.locator('.novedades-chips').textContent(), /Sin destinatarios/u);
  assert.equal(await page.evaluate(() => document.querySelector('.novedades-panel').contains(document.activeElement)), true, 'focus returns inside the panel');
  assert.match(await composer.locator('.novedades-audience-note').textContent(), /privacidad/u, 'la nota de audiencia no promete visibilidad');

  // Content-type switch, local preview and the limits that must never become a request.
  await composer.locator('.novedades-type-option', { hasText: 'Imagen' }).click();
  assert.equal(await composer.locator('.novedades-media-block').isVisible(), true);
  assert.equal(await composer.locator('.novedades-style-block').isVisible(), false);
  assert.equal(await composer.locator('.novedades-file-hint').textContent(), 'JPG, PNG o WEBP · hasta 10 MiB');
  await composer.locator('input[type="file"]').setInputFiles({ name: 'grande.png', mimeType: 'image/png', buffer: Buffer.alloc(11 * 1024 * 1024, 7) });
  assert.match(await errorLine.textContent(), /11 MiB/u);
  assert.match(await errorLine.textContent(), /límite por estado es 10 MiB/u);
  await composer.locator('input[type="file"]').setInputFiles({ name: 'animado.gif', mimeType: 'image/gif', buffer: Buffer.from('gif') });
  assert.match(await errorLine.textContent(), /Admitidos: JPG, PNG o WEBP/u);
  assert.equal(sent.length, 1, 'an oversized or unsupported file is refused before any request');
  assert.equal(await composer.locator('.novedades-media-remove').isVisible(), false, 'a refused file is not kept as the chosen media');

  await composer.locator('input[type="file"]').setInputFiles({ name: 'mini.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => (document.querySelector('.novedades-preview img')?.getAttribute('src') || '').startsWith('blob:'));
  assert.equal(await composer.locator('.novedades-media-remove').isVisible(), true);
  await composer.locator('#novedades-status-text').fill('Un fondo');
  await rows.first().locator('input[type="checkbox"]').check();
  await review.click();
  assert.match(await dialog.textContent(), /Imagen: mini\.png \(0 MiB\)/u);
  assert.match(await dialog.textContent(), /Vas a enviar el estado a 1 contacto:/u);
  assert.match(await dialog.textContent(), /privacidad/u, 'la confirmación recuerda que WhatsApp decide quién lo ve');
  await composer.locator('.novedades-confirm-send').click();
  await composerGone('la imagen confirmada cierra el editor');
  await waitUntil(() => sent.length === 2, 'image publish request');
  const imagePayload = sent[1];
  assert.equal(imagePayload.type, 'image');
  assert.equal(imagePayload.mimeType, 'image/png');
  assert.equal(imagePayload.text, 'Un fondo');
  assert.deepEqual(imagePayload.recipients, ['34600111222@s.whatsapp.net']);
  assert.equal(Buffer.from(imagePayload.data, 'base64').equals(png), true, 'the file travels as plain base64');
  assert.equal(Object.hasOwn(imagePayload, 'backgroundColor'), false, 'background and font are text-only fields');
  assert.equal(Object.hasOwn(imagePayload, 'font'), false);

  // A settled failure keeps the draft and is retried only when the owner asks.
  publishMode = 'reject';
  await openComposer();
  await composer.locator('#novedades-status-text').fill('Segundo intento');
  await rows.first().locator('input[type="checkbox"]').check();
  await review.click();
  await composer.locator('.novedades-confirm-send').click();
  await uiSettled(() => !document.querySelector('.novedades-confirm-dialog')
    && /no existe/u.test(document.querySelector('.novedades-composer-error')?.textContent || ''), 'el fallo cierto vuelve al editor');
  await waitUntil(() => sent.length === 3, 'rejected publish request');
  assert.equal(await composer.isVisible(), true, 'a settled failure leaves the composer open');
  assert.equal(await page.locator('.novedades-confirm-dialog').count(), 0);
  assert.equal(await errorLine.textContent(), 'El destinatario no existe en WhatsApp.');
  assert.equal(await composer.locator('#novedades-status-text').inputValue(), 'Segundo intento');
  assert.equal(await chips.count(), 1, 'the chosen audience survives a failure');
  await review.click();
  await composer.locator('.novedades-confirm-send').click();
  await uiSettled(() => !document.querySelector('.novedades-confirm-dialog'), 'el segundo intento recibe su respuesta');
  await waitUntil(() => sent.length === 4, 'a second attempt only happens after a new click');

  // An uncertain outcome says so and still keeps the draft.
  publishMode = 'uncertain';
  await review.click();
  await composer.locator('.novedades-confirm-send').click();
  await uiSettled(() => /puede haberse publicado/u.test(document.querySelector('.novedades-composer-error')?.textContent || ''), 'el fallo incierto se avisa como incierto');
  await waitUntil(() => sent.length === 5, 'unconfirmed publish request');
  assert.match(await errorLine.textContent(), /puede haberse publicado/u);
  assert.equal(await composer.locator('#novedades-status-text').inputValue(), 'Segundo intento');
  assert.equal(await chips.count(), 1);

  // A 200 without a message id is not proof of delivery either.
  publishMode = 'unconfirmed';
  await review.click();
  await composer.locator('.novedades-confirm-send').click();
  await uiSettled(() => /no confirmó la entrega/u.test(document.querySelector('.novedades-composer-error')?.textContent || ''), 'un cuerpo sin messageId no es confirmación');
  await waitUntil(() => sent.length === 6, 'publish request without a message id');
  assert.match(await errorLine.textContent(), /no confirmó la entrega/u);
  assert.equal(await composer.isVisible(), true, 'a partial body never clears the draft');

  // A 502 that still carries the refusal label proves nothing: the status is the
  // only fact here, and it says the audience may already hold the status.
  publishMode = 'refused5xx';
  await review.click();
  await composer.locator('.novedades-confirm-send').click();
  await uiSettled(() => /puede haberse publicado/u.test(document.querySelector('.novedades-composer-error')?.textContent || ''), 'un 5xx etiquetado como rechazo se avisa como incierto');
  await waitUntil(() => sent.length === 7, 'publish request answered 502 under a rejection label');
  assert.match(await errorLine.textContent(), /puede haberse publicado/u);

  // A 503 raised by the proxy itself refuses before dispatch: same 5xx, certain
  // answer, because no request ever reached WhatsApp.
  publishMode = 'credentials';
  await review.click();
  await composer.locator('.novedades-confirm-send').click();
  await uiSettled(() => !document.querySelector('.novedades-confirm-dialog')
    && /Connector credentials unavailable/u.test(document.querySelector('.novedades-composer-error')?.textContent || ''), 'el 503 previo al envío se avisa como fallo cierto');
  await waitUntil(() => sent.length === 8, 'publish request refused before dispatch');
  assert.doesNotMatch(await errorLine.textContent(), /puede haberse publicado/u, 'una petición no despachada no se anuncia como publicada quizá');
  assert.equal(await composer.locator('#novedades-status-text').inputValue(), 'Segundo intento');

  // Mid-flight account switch: the old account may not answer for the new one.
  publishMode = 'slow';
  let release;
  publishGate = new Promise(resolve => { release = resolve; });
  await composer.locator('#novedades-status-text').fill('Cambia la cuenta');
  await review.click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.novedades-confirm-dialog').count(), 0, 'Escape leaves the editor standing');
  assert.equal(await composer.isVisible(), true);
  await review.click();
  await composer.locator('.novedades-confirm-send').click();
  await uiSettled(() => document.querySelector('.novedades-confirm-send')?.disabled === true, 'el envío en curso bloquea el botón');
  await waitUntil(() => sent.length === 9, 'in-flight publish request');
  assert.equal(await composer.locator('.novedades-confirm-send').isDisabled(), true, 'a second send click is not possible while in flight');
  await page.evaluate(() => document.querySelector('.novedades-confirm-send').click());
  assert.equal(sent.length, 9, 'an in-flight publish is never sent twice');

  // Nothing may walk away from the answer while it is still undecided: both
  // exits stay shut and the list is not reloaded behind the notice.
  const readsBeforeFlight = statusReads.length;
  const authorsBeforeFlight = authorsCalls;
  assert.equal(await composer.locator('.novedades-back').isDisabled(), true, 'the composer cannot be left during a send');
  assert.equal(await composer.locator('.novedades-composer-discard').isDisabled(), true, 'discarding waits for the answer too');
  assert.equal(await composer.locator('.novedades-back').getAttribute('aria-disabled'), 'true', 'and says so to a reader');
  await page.evaluate(() => document.querySelector('.novedades-confirm-back')?.click());
  assert.equal(await page.locator('.novedades-confirm-dialog').count(), 1, 'ni el paso de confirmación se cierra en curso');
  await page.keyboard.press('Escape');
  await uiSettled(() => !document.querySelector('.novedades-confirm-dialog'), 'Escape deja el editor abierto');
  await page.keyboard.press('Escape');
  assert.equal(await composer.isVisible(), true, 'la segunda Escape tampoco cierra el editor con un envío en curso');
  assert.equal(await composer.locator('#novedades-status-text').inputValue(), 'Cambia la cuenta', 'el borrador sigue intacto');
  assert.equal(await chips.count(), 1, 'y su audiencia también');
  assert.equal(statusReads.length, readsBeforeFlight, 'la lista de estados no se recarga con un envío en curso');
  assert.equal(authorsCalls, authorsBeforeFlight, 'ni se piden autores nuevos');

  await page.getByRole('button', { name: 'Cuenta de WhatsApp: Beta' }).click();
  await page.waitForFunction(() => document.querySelector('[data-account-id="beta"]')?.getAttribute('aria-pressed') === 'true');
  assert.equal(await page.evaluate(() => document.querySelector('#account')?.value), 'beta', 'the rail entry really switched the account');
  assert.equal(await page.locator('.novedades-composer').count(), 0, 'the account switch closes the editor');
  release();
  await waitUntil(() => sent.length === 9, 'the late answer is consumed');
  assert.equal(sent.length, 9, 'a late answer never triggers a second request');
  await page.waitForFunction(() => /cuenta alpha/u.test(document.querySelector('.novedades-status')?.textContent || ''));
  assert.doesNotMatch(await page.locator('.novedades-status').textContent(), /Estado publicado\./u, 'the previous account cannot claim a success here');
  assert.deepEqual(sent.filter(payload => payload.account === 'beta'), [], 'nothing was published for the new account');

  await openComposer();
  assert.equal(await composer.locator('#novedades-status-text').inputValue(), '', 'the old draft does not follow the account switch');
  assert.equal(await chips.count(), 0);
  await waitUntil(() => contactCalls.some(call => call.account === 'beta' && call.limit === '50'), 'the new account fetches its own directory');
  await uiSettled(() => document.querySelectorAll('.novedades-audience-row').length === 3, 'the audience list of the new account renders');
  assert.equal(contactCalls.filter(call => call.account === 'beta').length, 1, 'one directory page per composer, not one per keystroke');
  assert.equal(await rows.count(), 3, 'the audience list belongs to the account on screen');
  assert.deepEqual(pageErrors, [], 'no page errors');

  // Mobile: the editor owns the viewport and the confirmation keeps focus.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', error => pageErrors.push(error.message));
  await mobile.goto(origin);
  await mobile.locator('[data-account-id="alpha"]').waitFor();
  await mobile.getByRole('button', { name: 'Estados', exact: true }).click();
  await mobile.waitForFunction(() => document.querySelector('.novedades-panel')?.getAttribute('aria-busy') === 'false');
  await mobile.getByRole('button', { name: 'Publicar un estado nuevo' }).click();
  await mobile.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'), null, { timeout: 5000 });
  if (process.env.UI_SCREENSHOT_PATH) await mobile.screenshot({ path: process.env.UI_SCREENSHOT_PATH });
  const mobileComposer = await mobile.locator('.novedades-composer').boundingBox();
  assert.equal(Math.round(mobileComposer.width), 390, 'the composer is full-bleed on a phone');
  assert.equal(Math.round(mobileComposer.x), 0, 'the composer starts at the screen edge');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), 390, 'nothing overflows the phone viewport horizontally');
  assert.equal(await mobile.locator('.novedades-composer').evaluate(node => getComputedStyle(node).borderLeftWidth), '0px', 'the phone editor has no inner border eating the edge');
  const sendButton = await mobile.locator('.novedades-review').boundingBox();
  assert(sendButton.x >= 0 && sendButton.x + sendButton.width <= 390 && sendButton.y + sendButton.height <= 844, 'the send button stays inside the viewport');
  await mobile.locator('.novedades-composer-text').fill('Desde el móvil');
  await mobile.locator('.novedades-audience-row').first().locator('input[type="checkbox"]').check();
  await mobile.locator('.novedades-review').click();
  await mobile.waitForFunction(() => document.querySelector('.novedades-confirm-dialog') !== null);
  await mobile.locator('.novedades-confirm-back').focus();
  await mobile.keyboard.press('Shift+Tab');
  assert.equal(await mobile.evaluate(() => document.querySelector('.novedades-confirm-dialog')?.contains(document.activeElement)), true, 'focus stays inside the confirmation');
  await mobile.keyboard.press('Escape');
  assert.equal(await mobile.locator('.novedades-confirm-dialog').count(), 0);
  assert.equal(await mobile.locator('.novedades-composer').count(), 1, 'Escape returns to the editor, not out of Novedades');
  await mobile.keyboard.press('Escape');
  assert.equal(await mobile.locator('.novedades-composer').count(), 0);
  assert.equal(await mobile.locator('.novedades-panel').count(), 1);
  await mobile.keyboard.press('Escape');
  assert.equal(await mobile.locator('.novedades-panel').count(), 0);

  // Sending disabled on the server takes the whole composer away.
  const muted = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  muted.on('pageerror', error => pageErrors.push(error.message));
  sendingEnabled = false;
  await muted.goto(origin);
  await muted.locator('[data-account-id="alpha"]').waitFor();
  await muted.getByRole('button', { name: 'Estados', exact: true }).click();
  await muted.waitForFunction(() => document.querySelector('.novedades-panel')?.getAttribute('aria-busy') === 'false');
  assert.equal(await muted.getByRole('button', { name: 'Publicar un estado nuevo' }).count(), 0, 'no publish entry when the server refuses sends');
  await muted.keyboard.press('Escape');
  sendingEnabled = true;

  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('Novedades publicar estado: audiencia explícita y confirmada, límites locales, borrador intacto ante fallos y cuenta nueva sin éxitos ajenos');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
