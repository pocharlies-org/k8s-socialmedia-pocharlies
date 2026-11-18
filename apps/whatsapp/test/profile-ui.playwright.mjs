import assert from 'node:assert/strict';
import { startPublicFixture } from './browser-fixture.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
const server = await startPublicFixture();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome' });
const page = await browser.newPage();
const errors = [];
const writes = [];
const photoWrites = [];
const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
const profiles = { alpha: { name: 'Alex', about: 'Disponible', phone: '+34000000001', photo: { available: false } }, beta: { name: 'Bea', about: 'Otro perfil', phone: '+34000000002', photo: { available: false } } };
let confirmed = true;
let releaseRead;
let delayRead = false;
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  const body = request.method() === 'GET' ? null : request.postDataJSON();
  const account = body?.account || url.searchParams.get('account') || 'alpha';
  const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  if (url.pathname === '/api/accounts') return json({ accounts: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }], sendingEnabled: true });
  if (url.pathname === '/api/chats') return json({ chats: [] });
  if (url.pathname === '/api/profile/photo' && !body) return route.fulfill({ contentType: 'image/png', body: validPng });
  if (url.pathname.startsWith('/api/profile/photo') && body) {
    photoWrites.push(body);
    profiles[account].photo.available = !url.pathname.endsWith('/remove');
    return json({ account, confirmed: true, profile: { photo: profiles[account].photo } });
  }
  if (url.pathname === '/api/profile') {
    if (body) { writes.push(body); if (confirmed) Object.assign(profiles[account], body); }
    if (!body && delayRead) await new Promise(resolve => { releaseRead = resolve; });
    return json({ account, profile: profiles[account], capabilities: { name: true, about: true, photo: true, photoRemove: true }, sendingEnabled: true, ...(body ? { confirmed } : {}) });
  }
  return json({ items: [], communities: [], models: [], sessions: [], lists: [], favorites: [] });
});
async function openProfile() {
  await page.locator('.rail-settings summary').click();
  await page.locator('#profile-toggle').click();
  await page.waitForFunction(() => document.querySelector('#profile-panel').getAttribute('aria-busy') === 'false');
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('#account').options.length === 2);
  await openProfile();
  assert.equal(await page.locator('#profile-panel [name=name]').inputValue(), 'Alex');
  await page.locator('#profile-panel .profile-save').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Cerrar perfil', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.locator('#profile-panel [name=name]').fill('Alex nuevo');
  await page.locator('#profile-panel [name=about]').fill('');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await page.getByText('Perfil actualizado.', { exact: true }).waitFor();
  assert.deepEqual(writes[0], { name: 'Alex nuevo', about: '', account: 'alpha' });
  confirmed = false;
  await page.locator('#profile-panel [name=about]').fill('Sin confirmar');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await page.getByText(/WhatsApp todavía no ha confirmado/).waitFor();
  assert.equal(await page.locator('#profile-panel [name=about]').inputValue(), '');
  await page.locator('#profile-panel .profile-file').setInputFiles({ name: 'demasiado-grande.png', mimeType: 'image/png', buffer: Buffer.alloc(8 * 1024 * 1024 + 1) });
  await page.getByText('Elige una imagen JPEG, PNG o WebP de hasta 8 MiB.', { exact: true }).waitFor();
  assert.equal(photoWrites.length, 0);
  await page.locator('#profile-panel .profile-file').setInputFiles({ name: 'perfil.png', mimeType: 'image/png', buffer: validPng });
  await page.getByText('Perfil actualizado.', { exact: true }).waitFor();
  await page.locator('#profile-panel img').evaluate(async image => { await image.decode(); });
  assert.equal(await page.locator('#profile-panel img').evaluate(image => image.naturalWidth), 1);
  assert.equal(photoWrites[0].account, 'alpha');
  assert.equal(photoWrites[0].data, validPng.toString('base64'));
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Quitar foto', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#profile-panel img').hidden);
  assert.equal(photoWrites.length, 2);
  await page.keyboard.press('Escape');
  delayRead = true;
  await page.locator('.rail-settings summary').click();
  await page.locator('#profile-toggle').click();
  while (!releaseRead) await new Promise(resolve => setTimeout(resolve, 10));
  await page.getByRole('button', { name: 'Cuenta de WhatsApp: Beta', exact: true }).click();
  delayRead = false;
  releaseRead();
  await openProfile();
  assert.equal(await page.locator('#profile-panel [name=name]').inputValue(), 'Bea');
  assert.equal(writes.length, 2);
  if (process.env.UI_OUTPUT_DIR) await mkdir(process.env.UI_OUTPUT_DIR, { recursive: true });
  for (const [width, height, theme] of [[1280, 800, 'light'], [1280, 800, 'dark'], [390, 844, 'light']]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => { document.body.dataset.theme = theme; }, theme);
    const bounds = await page.locator('#profile-panel').boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    const contrast = await page.locator('.profile-save').evaluate(element => {
      const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const styles = getComputedStyle(element);
      const values = [luminance(styles.color), luminance(styles.backgroundColor)].sort((a, b) => b - a);
      return (values[0] + .05) / (values[1] + .05);
    });
    assert(contrast >= 4.5, `Profile save text contrast in ${theme}: ${contrast}`);
    if (process.env.UI_OUTPUT_DIR) await page.screenshot({ path: path.join(process.env.UI_OUTPUT_DIR, `profile-${width}-${theme}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', writes: writes.length, liveMutations: 0 }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
