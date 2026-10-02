import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const basic = `Basic ${Buffer.from('tester:fixture').toString('base64')}`;

// One app instance per fixture, with a fake registry, a fake database and a
// recording fake connector. `answer` returns the provider replies.
async function start({ answer, rows = [], env = {} }) {
  const calls = [];
  const statements = [];
  const app = await createApp({
    env: {
      DATA_DIR: await mkdtemp(join(tmpdir(), 'wa-blocked-test-')),
      UI_AUTH_USERNAME: 'tester', UI_AUTH_PASSWORD: 'fixture',
      APP_PUBLIC_URL: 'https://wa.example', APP_ENABLE_SENDING: 'true',
      A_SECRET: 'a', B_SECRET: 'b', ...env,
    },
    registry: ['a', 'b'].map(accountId => ({
      channel: 'whatsapp', accountId, secretEnv: `${accountId.toUpperCase()}_SECRET`,
      connectorUrl: `http://connector-${accountId}`,
    })),
    db: {
      query: async (statement, args) => {
        assert.doesNotMatch(statement, /DELETE|UPDATE|INSERT/i);
        statements.push({ statement, args });
        const origin = /FROM whatsapp_contacts/.test(statement) ? 'contact'
          : /FROM conversations/.test(statement) ? 'chat'
            : /FROM participants/.test(statement) ? 'participant' : null;
        if (!origin) return { rows: [] };
        return { rows: rows.filter(row => row.origin === origin && row.account === args[0]) };
      },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return answer(url, options);
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  return {
    app,
    calls,
    statements,
    close: () => app.close(),
    read: (account, headers = {}) => fetch(`http://127.0.0.1:${port}/api/blocked-contacts?${new URLSearchParams({ account })}`, {
      headers: { authorization: basic, ...headers },
    }),
    unblock: (body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/blocked-contacts`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', origin: 'https://wa.example', authorization: basic, ...headers },
    }),
  };
}

const blockedList = (account, blocked, confirmed = true) => Response.json({ ok: true, account, blocked, count: blocked.length, confirmed });

test('the blocked list is provider-owned, account-scoped and read-only', async t => {
  let reply = async () => blockedList('a', [
    '34600111223@lid', '34600111222@s.whatsapp.net', '34600111221@s.whatsapp.net',
    '34600111220@s.whatsapp.net', '34600111224@s.whatsapp.net',
    '123@g.us', '120341@newsletter', undefined, '34600111222@s.whatsapp.net',
  ]);
  const fixture = await start({
    answer: (url, options) => reply(url, options),
    rows: [
      { origin: 'contact', account: 'a', jid: '34600111222@s.whatsapp.net', name: 'Ada', pushName: 'Ada Push' },
      // Saved under the legacy `@c.us` spelling of the same phone number.
      { origin: 'contact', account: 'a', jid: '34600111220@c.us', name: 'Guardado en c.us' },
      { origin: 'chat', account: 'a', jid: 'a:34600111223@lid', name: 'Lid Chat', waChatId: '34600111223@lid' },
      { origin: 'chat', account: 'a', jid: 'a:34600111224@c.us', name: 'Chat en c.us', waChatId: '34600111224@c.us' },
      { origin: 'participant', account: 'a', jid: '34600111221@s.whatsapp.net', name: '34600111221@s.whatsapp.net', pushName: '   ' },
      { origin: 'contact', account: 'b', jid: '34600111222@s.whatsapp.net', name: 'Otro account' },
    ],
  });
  t.after(() => fixture.close());

  const response = await fixture.read('a');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    account: 'a',
    contacts: [
      { jid: '34600111220@s.whatsapp.net', name: 'Guardado en c.us' },
      { jid: '34600111221@s.whatsapp.net' },
      { jid: '34600111222@s.whatsapp.net', name: 'Ada' },
      { jid: '34600111223@lid', name: 'Lid Chat' },
      { jid: '34600111224@s.whatsapp.net', name: 'Chat en c.us' },
    ],
    count: 5,
    confirmed: true,
    source: 'provider',
  });
  // One provider read, and it is a read: the app never sends a body or a verb
  // that could touch a contact while listing.
  assert.deepEqual(fixture.calls, [{ url: 'http://connector-a/api/v1/contacts/blocklist', method: 'GET', body: null }]);
  // Names come from this account's own rows only.
  assert.ok(fixture.statements.every(statement => statement.args[0] === 'a'));
  // The lookup carries the stored spelling of a phone number, not only the
  // normalized one, or an old saved contact would read as anonymous.
  assert.ok(fixture.statements.some(statement => statement.args[1]?.includes?.('34600111220@c.us')));
  assert.ok(fixture.statements.some(statement => statement.args[1]?.includes?.('a:34600111224@c.us')));

  fixture.calls.length = 0;
  assert.equal((await fixture.read('a', { authorization: '' })).status, 401);
  assert.equal((await fixture.read('missing')).status, 404);
  assert.deepEqual(fixture.calls, []);

  // A connector that speaks for another account is refused, not displayed.
  assert.equal((await fixture.read('b')).status, 502);
  assert.equal((await (await fixture.read('b')).json()).code, 'ACCOUNT_MISMATCH');
  reply = async () => Response.json({ok: true, blocked: ['34600111222@s.whatsapp.net'], confirmed: true});
  assert.equal((await fixture.read('a')).status, 502, 'a list without an account cannot prove which socket answered');

  // A disconnected session has no answer, which is not an empty list.
  reply = async () => Response.json({ ok: false, error: { code: 'CONTACT_BLOCK_ERROR', message: 'WhatsApp is not connected' } }, { status: 503 });
  const down = await fixture.read('a');
  assert.equal(down.status, 503);
  assert.equal((await down.json()).code, 'SESSION_DOWN');

  // An older connector without the route is reported as unsupported.
  reply = async () => Response.json({ ok: false, error: { code: 'NOT_FOUND' } }, { status: 404 });
  assert.equal((await fixture.read('a')).status, 501);

  // A provider answer that does not confirm the read cannot be shown as truth.
  reply = async () => blockedList('a', ['34600111222@s.whatsapp.net'], false);
  assert.equal((await fixture.read('a')).status, 502);

  // An empty blocklist is a real answer and must not consult the directory.
  reply = async () => blockedList('a', []);
  const empty = await fixture.read('a');
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { account: 'a', contacts: [], count: 0, confirmed: true, source: 'provider' });
});

test('a blocked address without a local conversation unblocks by provider JID', async t => {
  let state = [];
  const writes = [];
  const fixture = await start({
    answer: async (url, options) => {
      if (options.method === 'GET') return blockedList('a', state);
      const jid = decodeURIComponent(url.split('/chats/')[1].split('/block')[0]);
      writes.push(jid);
      state = state.filter(entry => entry !== jid);
      return Response.json({ ok: true, blocked: false, changed: true, confirmed: true });
    },
    rows: [],
  });
  t.after(() => fixture.close());
  state = ['34600111223@lid', '34600111222@s.whatsapp.net'];

  for (const body of [
    { account: 'a', jid: '123@g.us', action: 'unblock' },
    { account: 'a', jid: '120341@newsletter', action: 'unblock' },
    { account: 'a', jid: 'status@broadcast', action: 'unblock' },
    { account: 'a', jid: 'other:123@c.us', action: 'unblock' },
    { account: 'a', jid: 'no-me', action: 'unblock' },
    { account: 'a', jid: '34600111222@s.whatsapp.net', action: 'block' },
    { account: 'missing', jid: '34600111222@s.whatsapp.net', action: 'unblock' },
  ]) {
    fixture.calls.length = 0;
    assert.equal((await fixture.unblock(body)).status, body.account === 'missing' ? 404 : 400);
    assert.deepEqual(fixture.calls, [], `${body.jid}/${body.action} must not reach the provider`);
  }

  assert.equal((await fixture.unblock({ account: 'a', jid: '34600111223@lid', action: 'unblock' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fixture.unblock({ account: 'a', jid: '34600111223@lid', action: 'unblock' }, { authorization: '' })).status, 401);

  // An address the provider does not list as blocked is never written.
  fixture.calls.length = 0;
  assert.equal((await fixture.unblock({ account: 'a', jid: '34999888777@lid', action: 'unblock' })).status, 409);
  assert.deepEqual(fixture.calls.map(call => call.method), ['GET']);
  assert.deepEqual(writes, []);

  fixture.calls.length = 0;
  const unblocked = await fixture.unblock({ account: 'a', jid: '34600111223@lid', action: 'unblock' });
  assert.equal(unblocked.status, 200);
  assert.deepEqual(await unblocked.json(), {
    account: 'a', jid: '34600111223@lid', action: 'unblock', blocked: false, changed: true, confirmed: true, source: 'provider',
  });
  assert.deepEqual(fixture.calls, [
    { url: 'http://connector-a/api/v1/contacts/blocklist', method: 'GET', body: null },
    { url: 'http://connector-a/api/v1/chats/34600111223%40lid/block', method: 'POST', body: { blocked: false } },
  ]);
  assert.deepEqual(writes, ['34600111223@lid']);
  // No conversation row was read at all: the address belongs to the provider, not
  // to a local chat, and the write is the only thing that happened.
  assert.deepEqual(fixture.statements, []);
  // The list reload the browser performs after a confirmation sees the result.
  const reload = await fixture.read('a');
  assert.equal(reload.status, 200);
  assert.deepEqual(await reload.json(), {
    account: 'a', contacts: [{ jid: '34600111222@s.whatsapp.net' }], count: 1, confirmed: true, source: 'provider',
  });
});

test('an unblock that the provider does not confirm is reported as unconfirmed', async t => {
  let confirm = false;
  const fixture = await start({
    answer: async (url, options) => (options.method === 'GET'
      ? blockedList('a', ['34600111222@s.whatsapp.net'])
      : Response.json({ ok: true, blocked: true, changed: false, confirmed: confirm })),
    rows: [],
  });
  t.after(() => fixture.close());
  assert.equal((await fixture.unblock({ account: 'a', jid: '34600111222@s.whatsapp.net', action: 'unblock' })).status, 502);
  confirm = true;
  assert.equal((await fixture.unblock({ account: 'a', jid: '34600111222@s.whatsapp.net', action: 'unblock' })).status, 502);
});

test('an upstream rejection after unblock remains explicitly unconfirmed', async t => {
  for (const status of [400, 409, 500]) {
    const fixture = await start({
      answer: async (_url, options) => options.method === 'GET'
        ? blockedList('a', ['34600111222@s.whatsapp.net'])
        : Response.json({ok: false, error: {message: 'Provider failure'}}, {status}),
      rows: [],
    });
    t.after(() => fixture.close());
    const response = await fixture.unblock({account: 'a', jid: '34600111222@s.whatsapp.net', action: 'unblock'});
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /No se pudo confirmar si WhatsApp desbloqueó/);
  }
});

test('unblocking stays behind the sending gate', async t => {
  const fixture = await start({
    answer: async () => blockedList('a', ['34600111222@s.whatsapp.net']),
    rows: [],
    env: { APP_ENABLE_SENDING: 'false' },
  });
  t.after(() => fixture.close());
  fixture.calls.length = 0;
  assert.equal((await fixture.unblock({ account: 'a', jid: '34600111222@s.whatsapp.net', action: 'unblock' })).status, 403);
  assert.deepEqual(fixture.calls, []);
});
