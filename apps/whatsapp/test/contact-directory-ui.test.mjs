/**
 * Unit checks for the "Nuevo chat" drawer client: what a typed number may dial,
 * how a server entry is trusted, and when a late answer must be thrown away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  CONTACT_DIRECTORY_ACTIONS,
  CONTACT_DIRECTORY_LIMIT,
  contactAvatarUrl,
  contactDirectoryUrl,
  contactEntryDisabled,
  contactEntryHint,
  createContactDirectoryClient,
  directoryStatusLabel,
  filterDirectoryEntries,
  normalizeContactEntry,
  typedPhoneTarget,
} from '../public/contact-directory-ui.mjs';

const account = 'personal';

test('a typed number can open a chat with a contact the account has never seen', () => {
  assert.deepEqual(typedPhoneTarget('  +34 600 11 22 33 '), {
    key: 'typed:34600112233',
    digits: '34600112233',
    display: '+34600112233',
    phone: '+34600112233',
  });
  assert.deepEqual(typedPhoneTarget('+34100000097'), {
    key: 'typed:34100000097',
    digits: '34100000097',
    display: '+34100000097',
    phone: '+34100000097',
  });
});

test('a nine digit number stays national so the connector applies its own country code', () => {
  assert.deepEqual(typedPhoneTarget('600 112 233'), {
    key: 'typed:600112233',
    digits: '600112233',
    display: '600 112 233',
    phone: '600 112 233',
  });
  assert.equal(typedPhoneTarget('+34600112233').phone, '+34600112233');
});

test('identifiers and fragments are not dialled as phone numbers', () => {
  for (const value of ['', '   ', 'ana', '1234@s.whatsapp.net', '123456789012345@lid', 'user@s.whatsapp.net', '+34600112233 extra', 'reunion viernes', '+12345', '12', '+346001122330000000', '34-600-11a-233']) {
    assert.equal(typedPhoneTarget(value), null, `expected ${JSON.stringify(value)} to be refused`);
  }
});

test('an entry is only usable through the channel the server actually proved', () => {
  const base = { key: 'chat:1', label: 'Ana', kind: 'chat' };
  assert.deepEqual(normalizeContactEntry(base, account), {
    key: 'chat:1', label: 'Ana', sublabel: '', kind: 'chat', chatId: null, phone: null,
    avatarUrl: '', hasChat: false, archived: false, canOpen: false, canStart: false,
  });
  assert.equal(normalizeContactEntry({ ...base, canOpen: true }, account).canOpen, false);
  assert.equal(normalizeContactEntry({ ...base, canOpen: true, chatId: 'chat-1' }, account).canOpen, true);
  assert.equal(normalizeContactEntry({ ...base, canStart: true, phone: '+34600112233' }, account).canStart, true);
});

test('a LID or JID never reaches the UI as a phone number', () => {
  const base = { key: 'contact:1', label: 'Ana', kind: 'contact', canStart: true };
  for (const phone of ['123456789012345', '346001122', '+34 600 11 22 33', '+34600112233@s.whatsapp.net', '12345']) {
    assert.equal(normalizeContactEntry({ ...base, phone }, account), null, `expected ${phone} to be refused`);
  }
});

test('rows without a key, label or known kind are dropped', () => {
  const base = { key: 'contact:1', label: 'Ana', kind: 'contact' };
  assert.equal(normalizeContactEntry(null, account), null);
  assert.equal(normalizeContactEntry('contact:1', account), null);
  assert.equal(normalizeContactEntry([], account), null);
  assert.equal(normalizeContactEntry({ ...base, key: '  ' }, account), null);
  assert.equal(normalizeContactEntry({ ...base, label: '' }, account), null);
  assert.equal(normalizeContactEntry({ ...base, kind: 'group' }, account), null);
  assert.equal(normalizeContactEntry({ ...base, kind: 'typed' }, account), null);
});

test('avatars only come from our own proxy for the requested account', () => {
  assert.equal(contactAvatarUrl('/api/chats/chat-1/avatar?account=personal', 'personal'), '/api/chats/chat-1/avatar?account=personal');
  assert.equal(contactAvatarUrl('/api/contacts/p-1/avatar?account=personal', 'personal'), '/api/contacts/p-1/avatar?account=personal');
  assert.equal(contactAvatarUrl('/api/chats/chat-1/avatar?account=secondary', 'personal'), '');
  assert.equal(contactAvatarUrl('/api/chats/chat-1/avatar', 'personal'), '');
  assert.equal(contactAvatarUrl('https://pps.whatsapp.net/v/e/abc.jpg', 'personal'), '');
  assert.equal(contactAvatarUrl('//evil.example/api/chats/chat-1/avatar', 'personal'), '');
  assert.equal(contactAvatarUrl('/api/chats/chat-1/preview', 'personal'), '');
  assert.equal(contactAvatarUrl('/api/avatar?path=/api/chats/a/avatar&account=personal', 'personal'), '');
});

test('an inherited avatar of another account is not rendered under this one', () => {
  const entry = normalizeContactEntry({
    key: 'chat:1', label: 'Ana', kind: 'chat', chatId: 'chat-1', canOpen: true,
    avatarUrl: '/api/chats/chat-1/avatar?account=secondary',
  }, account);
  assert.equal(entry.avatarUrl, '');
  assert.equal(normalizeContactEntry({
    key: 'chat:1', label: 'Ana', kind: 'chat', chatId: 'chat-1', canOpen: true,
    avatarUrl: '/api/chats/chat-1/avatar?account=personal',
  }, account).avatarUrl, '/api/chats/chat-1/avatar?account=personal');
});

test('the directory request only carries the account, page size and real filters', () => {
  assert.equal(contactDirectoryUrl({ account }), `/api/contacts?account=personal&limit=${CONTACT_DIRECTORY_LIMIT}`);
  assert.equal(contactDirectoryUrl({ account, q: '  maría  ' }), '/api/contacts?account=personal&limit=60&q=mar%C3%ADa');
  assert.equal(contactDirectoryUrl({ account, q: '', cursor: null }), '/api/contacts?account=personal&limit=60');
  assert.equal(contactDirectoryUrl({ account, limit: 200, cursor: 'c1', q: '9' }), '/api/contacts?account=personal&limit=200&q=9&cursor=c1');
  assert.equal(CONTACT_DIRECTORY_ACTIONS.map(item => item.action).join(','), 'group,contact,community');
});

test('every row says what pressing it will do', () => {
  const open = { canOpen: true, canStart: false, archived: false };
  assert.equal(contactEntryHint(open), 'Abre el chat existente');
  assert.equal(contactEntryHint({ ...open, archived: true }), 'Abre un chat archivado');
  assert.equal(contactEntryHint({ canOpen: false, canStart: true }), 'Empieza un chat sin enviar nada');
  assert.equal(contactEntryHint({ canOpen: false, canStart: true }, { sendingEnabled: false }), 'Envío desactivado');
  assert.equal(contactEntryHint({ canOpen: false, canStart: false }), 'Sin número sincronizado');
  assert.equal(contactEntryHint(null), '');
});

test('a row is disabled unless pressing it can actually do something', () => {
  assert.equal(contactEntryDisabled({ canOpen: true, canStart: false }), false);
  assert.equal(contactEntryDisabled({ canOpen: false, canStart: true }), false);
  assert.equal(contactEntryDisabled({ canOpen: false, canStart: true }, { sendingEnabled: false }), true);
  assert.equal(contactEntryDisabled({ canOpen: false, canStart: false }), true);
  assert.equal(contactEntryDisabled(null), true);
});

test('the status line reports the real identity count and its age', () => {
  // es-ES only groups from five digits on (CLDR minimumGroupingDigits), so the
  // assertions accept the separator when the locale decides to print one.
  assert.equal(directoryStatusLabel(null), '');
  const grouped = /^[0-9.,\u00A0 ]*$/;
  const line = directoryStatusLabel({ sync: { identities: 1340 } });
  assert.match(line, /^1[.,\u00A0 ]?340 contactos sincronizados en esta cuenta\.$/);
  assert.match(line.match(/^[^ ]+/)[0], grouped);
  const large = directoryStatusLabel({ sync: { identities: 12340 } });
  assert.match(large, /^12[.,\u00A0 ]?340 contactos sincronizados en esta cuenta\.$/);
  assert.match(directoryStatusLabel({ query: 'maria', total: 2, sync: { identities: 1340 } }),
    /^2 coincidencias entre 1[.,\u00A0 ]?340 contactos sincronizados/);
  assert.match(directoryStatusLabel({ sync: { identities: 7, latestSyncAt: '2026-09-27T10:00:00.000Z' } }),
    /^7 contactos sincronizados en esta cuenta · sincronizado el \d/);
  assert.equal(directoryStatusLabel({ sync: { identities: 7, latestSyncAt: 'not-a-date' } }), '7 contactos sincronizados en esta cuenta.');
  assert.equal(directoryStatusLabel({ query: '  ', sync: { identities: 0 } }), '0 contactos sincronizados en esta cuenta.');
});

function payload(overrides = {}) {
  return {
    account,
    query: '',
    sendingEnabled: true,
    total: 2,
    hasMore: false,
    nextCursor: null,
    contacts: [
      { key: 'chat:1', label: 'Ana', kind: 'chat', chatId: 'chat-1', canOpen: true },
      { key: 'contact:2', label: 'Bea', kind: 'contact', phone: '+34600112233', canStart: true },
    ],
    sync: { identities: 2 },
    ...overrides,
  };
}

test('the client asks for the selected account and keeps the paging contract', async () => {
  const calls = [];
  const client = createContactDirectoryClient({
    api: async url => { calls.push(url); return payload(); },
    getAccount: () => account,
  });
  const page = await client.page({ q: 'an' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /account=personal/);
  assert.match(calls[0], /q=an(&|$)/);
  assert.deepEqual(page.entries.map(entry => entry.key), ['chat:1', 'contact:2']);
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal(page.sendingEnabled, true);
});

test('a response that is not the requested account is an error, not another account', async () => {
  const client = createContactDirectoryClient({ api: async () => payload({ account: 'secondary' }), getAccount: () => account });
  await assert.rejects(() => client.page(), /no válida/);
  await assert.rejects(() => createContactDirectoryClient({ api: async () => ({ ...payload(), contacts: 'x' }), getAccount: () => account }).page(), /no válida/);
});

test('a response for a page size the server refused is surfaced, not swallowed', async () => {
  const client = createContactDirectoryClient({ api: async () => { throw new Error('El límite debe estar entre 1 y 200.'); }, getAccount: () => account });
  await assert.rejects(() => client.page(), /entre 1 y 200/);
});

test('a late answer is dropped when the account changed or the drawer restarted', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let current = account;
  const client = createContactDirectoryClient({ api: async () => { await gate; return payload({ account: current }); }, getAccount: () => current });
  const pending = client.page();
  current = 'secondary';
  release();
  assert.equal(await pending, null);

  current = account;
  const second = client.page();
  client.invalidate();
  release();
  assert.equal(await second, null);
});

test('a closed drawer without an account does not call the server', async () => {
  let calls = 0;
  const client = createContactDirectoryClient({ api: async () => { calls += 1; return payload(); }, getAccount: () => '' });
  assert.equal(await client.page(), null);
  assert.equal(calls, 0);
});

test('the client keeps only usable entries and normalizes the cursor', async () => {
  const client = createContactDirectoryClient({
    api: async () => payload({
      hasMore: true,
      nextCursor: 'cursor-2',
      contacts: [
        { key: 'chat:1', label: 'Ana', kind: 'chat', chatId: 'chat-1', canOpen: true },
        { key: '', label: 'Ruido', kind: 'chat' },
        { key: 'contact:3', label: 'Lid', kind: 'contact', phone: '123456789012345', canStart: true },
      ],
    }),
    getAccount: () => account,
  });
  const page = await client.page();
  assert.deepEqual(page.entries.map(entry => entry.key), ['chat:1']);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, 'cursor-2');
});

test('el filtro local pliega tildes y los números buscan por dígitos (QA #103)', () => {
  const entries = [
    { key: 'a', label: 'Ibáñez', sublabel: '', phone: '+34600111222' },
    { key: 'b', label: 'Ana', sublabel: 'Cliente', phone: null },
  ];
  assert.deepEqual(filterDirectoryEntries(entries, 'ibanez').map(e => e.key), ['a']);
  assert.deepEqual(filterDirectoryEntries(entries, 'cliente').map(e => e.key), ['b']);
  assert.deepEqual(filterDirectoryEntries(entries, '600 111').map(e => e.key), ['a']);
  assert.equal(filterDirectoryEntries(entries, '').length, 2);
});

test('la misma página repetida sale de la caché sin re-pedir (QA #103)', async () => {
  let calls = 0;
  const client = createContactDirectoryClient({
    api: async () => { calls += 1; return payload(); },
    getAccount: () => account,
  });
  await client.page({ q: 'an' });
  await client.page({ q: 'an' });
  assert.equal(calls, 1);
  await client.page({ q: 'bea' });
  assert.equal(calls, 2);
});
test('open({query}) prellena el buscador del directorio (QA #125)', async () => {
  const src = await readFile(new URL('../public/contact-directory-ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /function open\(\{ opener = null, query = '' \} = \{\}\)/);
  assert.match(src, /if \(state\.queryInput\) input\.value = state\.queryInput;/);
});
