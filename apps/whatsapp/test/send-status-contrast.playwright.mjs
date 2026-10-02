#!/usr/bin/env node
/*
 * The pending-send receipt ("Enviando…", "Entrega no confirmada", the recovery
 * buttons and the message clock) sits inside the bubble, so it has to stay legible
 * on both bubble colors of both themes. WCAG AA for this 11px text is 4.5:1.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const publicDir = path.resolve(process.env.UI_SOURCE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'));
const server = createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname;
  const filename = path.resolve(publicDir, `.${name === '/' ? '/index.html' : name}`);
  if (!filename.startsWith(`${publicDir}${path.sep}`)) return response.writeHead(403).end();
  try {
    const body = await readFile(filename);
    response.writeHead(200, {'content-type': {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'}[path.extname(filename)] || 'application/octet-stream'}).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome'});
const page = await browser.newPage();
const errors = [];
let sendRoute = null;
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  const json = body => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(body)});
  if (url.pathname === '/api/accounts') return json({accounts: [{id: 'alpha', label: 'Alpha'}], sendingEnabled: true, outboxScope: 'contrast-check'});
  if (url.pathname === '/api/chats') return json({chats: [{id: 'one', name: 'Uno'}]});
  if (url.pathname === '/api/messages') return json({messages: [
    {id: 'in-1', senderName: 'Ana', text: 'Mensaje entrante de prueba', fromMe: false, timestamp: '2026-09-24T08:00:00.000Z'},
    {id: 'out-1', text: 'Mensaje saliente ya confirmado', fromMe: true, timestamp: '2026-09-24T08:01:00.000Z'}
  ]});
  if (url.pathname === '/api/send') { sendRoute = route; return; }
  return json({});
});

const MEASURE = selectors => {
  const parse = value => {
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return {r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? (parts[3] > 1 ? parts[3] / 255 : parts[3]) : 1};
  };
  const channel = value => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const luminance = ({r, g, b}) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const composite = (fore, back) => ({r: fore.a * fore.r + (1 - fore.a) * back.r, g: fore.a * fore.g + (1 - fore.a) * back.g, b: fore.a * fore.b + (1 - fore.a) * back.b, a: 1});
  const opaqueBackground = element => {
    let node = element;
    while (node) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color.a === 1) return color;
      node = node.parentElement;
    }
    return {r: 255, g: 255, b: 255, a: 1};
  };
  return selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
    const raw = parse(getComputedStyle(element).color);
    const background = opaqueBackground(element.parentElement || element);
    const fore = raw.a === 1 ? raw : composite(raw, background);
    const [light, dark] = [luminance(fore), luminance(background)].sort((a, b) => b - a);
    return {selector, theme: document.body.dataset.theme, text: element.textContent.trim().slice(0, 24), color: getComputedStyle(element).color, background: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`, ratio: Number(((light + 0.05) / (dark + 0.05)).toFixed(2))};
  }));
};
const selectors = {
  pending: '.message[data-send-state="sending"] .message-send-feedback',
  failed: '.message[data-send-state="failed"] .message-send-feedback',
  restore: '.message-restore',
  incomingMeta: '.message.incoming .message-meta',
  outgoingMeta: '.message.from-me:not([data-send-state]) .message-meta'
};
const setTheme = async value => {
  await page.locator('#theme').evaluate((select, theme) => { select.value = theme; select.dispatchEvent(new Event('change', {bubbles: true})); }, value);
  await page.waitForFunction(theme => document.body.dataset.theme === theme, value);
};

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('.chat-item').first().click();
  await page.locator('.message.incoming').waitFor();

  for (const theme of ['dark', 'light']) {
    await setTheme(theme);
    await page.locator('#message').fill(`pendiente ${theme}`);
    await page.locator('#message').press('Enter');
    await page.locator('.message[data-send-state="sending"] .message-send-feedback').first().waitFor();
    const pending = await page.evaluate(MEASURE, [selectors.pending]);
    assert.equal(pending.length, 1, 'no pending send receipt to measure');
    assert.match(pending[0].text, /Enviando/, 'the pending receipt does not say Enviando');
    for (const sample of pending) assert(sample.ratio >= 4.5, `pending send receipt unreadable in ${theme} (${sample.ratio}:1, ${sample.color} on ${sample.background})`);

    await sendRoute.fulfill({status: 502, contentType: 'application/json', body: JSON.stringify({error: 'No confirmado'})});
    await page.locator('.message[data-send-state="failed"] .message-send-feedback').first().waitFor();
    const failed = await page.evaluate(MEASURE, [selectors.failed, selectors.restore]);
    assert(failed.length >= 3, 'the failed send receipt or its recovery actions are missing');
    assert.match(failed[0].text, /Entrega no confirmada/, 'the failed receipt did not explain the state');
    assert(failed.some(sample => sample.selector === selectors.restore), 'the recovery actions were not measured');
    for (const sample of failed) assert(sample.ratio >= 4.5, `failed send UI unreadable in ${theme} (${sample.ratio}:1, ${sample.color} on ${sample.background})`);
    assert.notEqual(failed[0].color, pending[0].color, 'a failed send looks identical to a pending one');

    const rest = await page.evaluate(MEASURE, [selectors.incomingMeta, selectors.outgoingMeta]);
    assert.equal(rest.length, 2, 'the message clock is missing from a bubble');
    for (const sample of rest) assert(sample.ratio >= 4.5, `message clock unreadable in ${theme} (${sample.ratio}:1, ${sample.color} on ${sample.background})`);
  }

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
