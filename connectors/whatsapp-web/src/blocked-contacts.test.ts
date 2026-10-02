import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { parseProviderBlocklist, readBlockedContacts } from './blocked-contacts';
import { ContactBlockError, readContactBlocked, setContactBlocked } from './contact-block';
import { BaileysClient } from './baileys-client';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

test('provider blocklist keeps direct contacts and drops every unusable entry', () => {
  // rc13 answers with the raw `item.attrs.jid` of each blocklist item.
  assert.deepEqual(
    parseProviderBlocklist([
      '34600111223@lid',
      '34600111222@s.whatsapp.net',
      '34600111221@c.us',
      '34600111220:7@lid',
      '34600111223@lid',
    ]),
    [
      '34600111220@lid',
      '34600111221@s.whatsapp.net',
      '34600111222@s.whatsapp.net',
      '34600111223@lid',
    ]
  );
  assert.deepEqual(
    parseProviderBlocklist([
      undefined,
      null,
      42,
      '',
      '120341@newsletter',
      '123@g.us',
      'status@broadcast',
      'me',
      'user:123@lid',
    ]),
    []
  );
  assert.deepEqual(parseProviderBlocklist([]), []);
});

test('a blocklist that is not a list is refused instead of reported as empty', () => {
  for (const raw of [null, {}, '34600111222@s.whatsapp.net', 7]) {
    assert.throws(
      () => parseProviderBlocklist(raw),
      (error: unknown) =>
        error instanceof ContactBlockError && error.status === 502 && /unusable/.test(error.message)
    );
  }
});

test('reading the blocklist asks the provider once and never touches a contact', async () => {
  const calls: string[] = [];
  const socket = {
    fetchBlocklist: async () => {
      calls.push('fetchBlocklist');
      return ['34600111222@s.whatsapp.net', '34600111222@s.whatsapp.net'];
    },
    updateBlockStatus: async () => {
      calls.push('updateBlockStatus');
    },
    signalRepository: { lidMapping: {} },
  };
  assert.deepEqual(await readBlockedContacts(socket), ['34600111222@s.whatsapp.net']);
  assert.deepEqual(calls, ['fetchBlocklist']);
});

test('the blocked list refuses a disconnected provider', async () => {
  await assert.rejects(
    BaileysClient.prototype.listBlockedContacts.call({
      sock: null,
      isConnected: () => false,
    } as any),
    (error: unknown) =>
      error instanceof ContactBlockError &&
      error.status === 503 &&
      /not connected/.test(error.message)
  );
});

test('GET /contacts/blocklist is authenticated, account-scoped and read-only', async () => {
  const previous = process.env.CONNECTOR_ACCOUNT;
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const secret = 'blocklist-fixture';
  const touched: string[] = [];
  const client = {
    listBlockedContacts: async () => {
      touched.push('listBlockedContacts');
      return ['34600111220@lid', '34600111222@s.whatsapp.net'];
    },
    blockContact: async () => {
      touched.push('blockContact');
      return { blocked: false, changed: true, confirmed: true };
    },
    contactBlocked: async () => {
      touched.push('contactBlocked');
      return true;
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createRouter(client as any, {} as any, secret));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const signedGet = (target: string, port: number, signed = true) => {
    const timestamp = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}${target}`, {
      headers: signed
        ? {
            'x-connector-timestamp': String(timestamp),
            'x-connector-signature': generateHMACSignature({}, timestamp, secret),
          }
        : {},
    });
  };
  try {
    const port = (server.address() as any).port;
    assert.equal((await signedGet('/contacts/blocklist', port, false)).status, 401);
    assert.deepEqual(await (await signedGet('/contacts/blocklist', port)).json(), {
      ok: true,
      account: 'personal',
      blocked: ['34600111220@lid', '34600111222@s.whatsapp.net'],
      count: 2,
      confirmed: true,
    });
    assert.deepEqual(touched, ['listBlockedContacts']);

    const down = express();
    down.use(express.json());
    down.use(
      createRouter(
        {
          listBlockedContacts: async () => {
            throw new ContactBlockError('WhatsApp is not connected', 503);
          },
        } as any,
        {} as any,
        secret
      )
    );
    const downServer = down.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => downServer.once('listening', () => resolve()));
    try {
      const response = await signedGet('/contacts/blocklist', (downServer.address() as any).port);
      assert.equal(response.status, 503);
      const body = (await response.json()) as { ok: boolean; error: { code: string } };
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'CONTACT_BLOCK_ERROR');
    } finally {
      await new Promise<void>(resolve => downServer.close(() => resolve()));
    }
  } finally {
    if (previous === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

/*
 * The list and the block read are two ways of asking one question, so they have
 * to agree: an address shown as blocked is an address the connector will find
 * blocked when it verifies a write. A caller that reads the list and then asks
 * for one of those addresses to be unblocked must never be told it was not
 * blocked in the first place.
 */
test('an address the list shows is the same address the block read confirms', async () => {
  const stored = [
    '34600111220@s.whatsapp.net',
    '34600111221@c.us',
    '34600111222:7@s.whatsapp.net',
    '34600111223@lid',
    '34600111221@s.whatsapp.net',
    '999@g.us',
    null,
  ];
  const socket = { fetchBlocklist: async () => [...stored] };
  const listed = parseProviderBlocklist(await socket.fetchBlocklist());
  assert.deepEqual(listed, [
    '34600111220@s.whatsapp.net',
    '34600111221@s.whatsapp.net',
    '34600111222@s.whatsapp.net',
    '34600111223@lid',
  ]);
  // The two spellings of one phone number are one blocked contact, not two rows.
  assert.equal(new Set(listed).size, listed.length);
  for (const jid of listed) {
    assert.equal(
      await readContactBlocked({ ...socket, signalRepository: { lidMapping: {} } }, jid),
      true,
      `${jid} is listed as blocked but the block read denies it`
    );
  }
});

test('a cleared address leaves the list that the browser reloads', async () => {
  const stored = ['34600111221@c.us', '444@lid'];
  const socket = {
    fetchBlocklist: async () => [...stored.slice()],
    updateBlockStatus: async (jid: string, action: string) => {
      if (action !== 'unblock') return;
      const written = jid.replace(/^(\d+):\d+@/, '$1@').replace(/@c\.us$/, '@s.whatsapp.net');
      for (let index = 0; index < stored.length; index += 1) {
        const entry = stored[index].replace(/^(\d+):\d+@/, '$1@').replace(/@c\.us$/, '@s.whatsapp.net');
        if (entry === written) stored.splice(index, 1);
      }
    },
    signalRepository: { lidMapping: {} },
  };
  assert.deepEqual(await readBlockedContacts(socket), ['34600111221@s.whatsapp.net', '444@lid']);
  assert.deepEqual(await setContactBlocked(socket, '34600111221@s.whatsapp.net', false), {
    blocked: false, changed: true, confirmed: true,
  });
  assert.deepEqual(await readBlockedContacts(socket), ['444@lid']);
});
