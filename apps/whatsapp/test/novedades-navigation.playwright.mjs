import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { servePublicAsset, createNovedadesTab } from './browser-fixture.mjs';

const requests = [];
const pageErrors = [];
const page = (account, extra = {}) => ({ account, hasMore: false, nextCursor: null, coverage: {}, ...extra });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture.local');
  if (url.pathname.startsWith('/api/')) {
    requests.push({ path: url.pathname, account: url.searchParams.get('account'), method: request.method });
    const account = url.searchParams.get('account');
    let data = {};
    if (url.pathname === '/api/accounts') data = { accounts: [{id: 'alpha', label: 'Alpha'}, {id: 'beta', label: 'Beta'}], sendingEnabled: false };
    if (url.pathname === '/api/chats') data = { chats: [], hasMore: false, nextCursor: null };
    if (url.pathname === '/api/novedades/status/authors') data = page(account, {authors: []});
    if (url.pathname === '/api/novedades/channels') data = page(account, {channels: []});
    response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(data));
    return;
  }
  await servePublicAsset(request, response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { browser, tab } = await createNovedadesTab(pageErrors);
try {
  await tab.goto(`http://127.0.0.1:${server.address().port}`);
  await tab.locator('[data-account-id="alpha"]').waitFor();
  await tab.getByRole('button', {name: 'Estados', exact: true}).click();
  await tab.getByRole('tab', {name: 'Estados', exact: true}).waitFor();
  await tab.waitForFunction(() => document.querySelector('.novedades-panel')?.getAttribute('aria-busy') === 'false');
  assert.deepEqual(requests.filter(item => item.path.startsWith('/api/novedades/')), [
    {path: '/api/novedades/status/authors', account: 'alpha', method: 'GET'},
  ], 'Opening statuses loads authors only; individual statuses require an explicit author');
  await tab.keyboard.press('Escape');
  await tab.getByRole('button', {name: 'Canales', exact: true}).click();
  await tab.waitForFunction(() => document.querySelector('.novedades-panel')?.getAttribute('aria-busy') === 'false');
  assert.equal(await tab.getByRole('tab', {name: 'Canales', exact: true}).getAttribute('aria-selected'), 'true');
  assert(requests.some(item => item.path === '/api/novedades/channels' && item.account === 'alpha'));
  await tab.keyboard.press('Escape');
  await tab.locator('[data-account-id="beta"]').click();
  await tab.getByRole('button', {name: 'Canales', exact: true}).click();
  await tab.waitForFunction(() => document.querySelector('.novedades-panel')?.getAttribute('aria-busy') === 'false');
  assert(requests.some(item => item.path === '/api/novedades/channels' && item.account === 'beta'));
  assert.equal(requests.filter(item => item.method !== 'GET').length, 0);
  assert.deepEqual(pageErrors, []);
  console.log('Novedades navigation: separate entries, author-first reads and account isolation pass');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
