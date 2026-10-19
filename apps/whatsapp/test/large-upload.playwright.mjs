#!/usr/bin/env node
// Real app HTTP/UI; only PostgreSQL rows and the external connector are fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const outputDir = path.resolve(process.env.UI_OUTPUT_DIR || '/tmp/socialmedia-large-upload-qa');
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
// A private ancillary PNG chunk keeps the image decodable while exceeding 4 MiB.
const chunk = Buffer.alloc(4 * 1024 * 1024 + 12, 0x61);
chunk.writeUInt32BE(4 * 1024 * 1024, 0);
chunk.write('npAD', 4, 'ascii');
let crc = 0xffffffff;
for (const byte of chunk.subarray(4, -4)) {
  crc ^= byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
}
chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
const png = Buffer.concat([tinyPng.subarray(0, -12), chunk, tinyPng.subarray(-12)]);
const digest = createHash('sha256').update(png).digest('hex');
assert(png.length > 4 * 1024 * 1024);
const caption = 'Large image regression';
const chat = { id: 'large-image-chat', name: 'Large image QA', wa_chat_id: 'large-image-chat', is_group: false, archived: false, unread: 0 };
const calls = [];
const effects = new Map();
let release;
const providerGate = new Promise(resolve => { release = resolve; });
const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-large-upload-'));
const env = { DATA_DIR: dir, HERMES_RUNS_ENABLED: 'false', APP_PUBLIC_URL: 'http://127.0.0.1',
  UI_AUTH_USERNAME: 'qa', UI_AUTH_PASSWORD: 'synthetic-password', APP_ENABLE_SENDING: 'true', PERSONAL_SECRET: 'synthetic-secret' };
const app = await createApp({ env,
  registry: [{ channel: 'whatsapp', accountId: 'personal', secretEnv: 'PERSONAL_SECRET', connectorUrl: 'http://fixture-connector' }],
  db: { query: async (sql, args) => ({ rows: /FROM conversations c/.test(sql)
    && args[0] === 'personal' && (args[1] === chat.id || typeof args[1] === 'boolean') ? [chat] : [] }) },
  fetchImpl: async (url, options) => {
    if (url.endsWith('/history/recover')) return Response.json({ ok: true, status: 'no_anchor', requested: 0, recovered: 0 });
    if (!url.endsWith('/messages/media/send')) return Response.json({ ok: true, chats: [], presence: [], items: [] });
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(body.conversationId, chat.wa_chat_id);
    assert.equal(body.fileName, 'large.png');
    assert.equal(body.caption, caption);
    assert.equal(body.sourceMimeType, 'image/png');
    assert.equal(body.sourceDigest, digest);
    assert.equal(body.quality, 'standard');
    assert.match(body.sendToken, /^[0-9a-f-]{36}$/);
    assert.equal(body.idempotencyKey, body.sendToken);
    assert(body.fileUrl.startsWith('data:image/png;base64,'));
    const decoded = Buffer.from(body.fileUrl.slice('data:image/png;base64,'.length), 'base64');
    assert.equal(decoded.length, png.length);
    assert.equal(createHash('sha256').update(decoded).digest('hex'), digest);
    await providerGate;
    // Model the connector's idempotency boundary; this is not a real-provider test.
    if (!effects.has(body.idempotencyKey)) effects.set(body.idempotencyKey, { messageId: 'large-image-receipt', confirmed: true });
    return Response.json(effects.get(body.idempotencyKey));
  },
});
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
env.APP_PUBLIC_URL = origin;
let browser;
let context;
let page;
try {
  await mkdir(outputDir, { recursive: true });
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1247/chrome-linux64/chrome' });
  context = await browser.newContext({ baseURL: origin, httpCredentials: { username: 'qa', password: 'synthetic-password' } });
  context.setDefaultTimeout(30000);
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.locator('#chats .chat-item').first().click();
  await page.locator('#attachment').setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: png });
  await page.locator('#attachment-thumbnail').evaluate(image => image.decode());
  assert.equal(await page.locator('#attachment-thumbnail').evaluate(image => image.naturalWidth), 1);
  await page.locator('#message').fill(caption);
  const responseReady = page.waitForResponse(response => new URL(response.url()).pathname === '/api/upload' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Enviar mensaje', exact: true }).click();
  const sending = page.locator('#messages [data-send-state="sending"]');
  await sending.waitFor();
  const optimistic = await sending.elementHandle();
  const optimisticId = await sending.getAttribute('data-message-id');
  release();
  const response = await responseReady;
  assert.equal(response.status(), 200, await response.text());
  assert.equal((await response.json()).messageId, 'large-image-receipt');
  await page.locator('#messages [data-send-state="confirmed"]').waitFor();
  assert.equal(await page.locator('#messages .message').count(), 1);
  assert.equal(await optimistic.evaluate(element => element.isConnected && element.dataset.sendState === 'confirmed'), true,
    'the optimistic bubble must be reconciled in place');
  assert.equal(await page.locator('#messages .message').getAttribute('data-message-id'), optimisticId);
  assert.equal(await page.locator('#messages [data-send-state="failed"], #messages .message-send-feedback').count(), 0);
  assert.equal(calls.length, 1);
  assert.equal(effects.size, 1);
  const firstPayload = response.request().postDataJSON();
  const retry = await context.request.post('/api/upload', { headers: { origin }, data: firstPayload });
  assert.equal(retry.status(), 200, await retry.text());
  assert.equal((await retry.json()).messageId, 'large-image-receipt');
  assert.equal(calls.length, 2, 'both HTTP attempts reach the connector boundary');
  assert.equal(calls[1].sendToken, calls[0].sendToken);
  assert.equal(effects.size, 1, 'the fixture provider applies exactly one send');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(outputDir, 'large-upload-confirmed.png'), animations: 'disabled' });
  console.log(JSON.stringify({ ok: true, uploadStatus: response.status(), retryStatus: retry.status(),
    bytes: png.length, sha256: digest, connectorRequests: calls.length, syntheticProviderSends: effects.size,
    sameOptimisticBubble: true, quality: calls[0].quality, browserErrors: errors }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(outputDir, 'large-upload-failure.png') }).catch(() => {});
  throw error;
} finally {
  release();
  await context?.close();
  await browser?.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
