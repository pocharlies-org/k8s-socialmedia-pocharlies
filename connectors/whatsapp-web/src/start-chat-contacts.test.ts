/**
 * Start chat, contacts and vCards (fase 3 / PR-9): a phone number resolves to
 * the conversation the account already has (the phone jid, or its LID twin
 * through 008's aliases, merged tombstones followed) and never creates a twin;
 * a new row only when there is none, under the LID with the phone in
 * wa_chat_id, and only with ingest on; the contact list collapses PN / LID
 * into one entry per person and never shows LID digits as a phone; a created
 * contact is WhatsApp's own address-book mutation; a shared contact is a
 * vCard with its waid, escaped; and the HTTP surface (signed body, the
 * sending gate, 422 not_on_whatsapp, errors with failureClass).
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test (same harness as privacy-disappearing.test.ts).
 * Ported and adapted from the NAS fork's startChat / listContacts /
 * createContact / shareContact / buildContactMessage.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import pg from 'pg';
import { BaileysClient, BaileysClientOptions } from './baileys-client';
import {
  buildContactShareContent,
  buildVcard,
  contactEntryFromRow,
  isJidLikeName,
  listAccountContacts,
  parseCreateContactRequest,
  parseShareContactRequest,
  parseStartChatRequest,
  parseVcardView,
  phoneFromUserJid,
  sharedContactsFromMessage,
  vcardEscape,
} from './contacts';
import { MessageMutationError } from './message-mutations';
import { resetChatStateForTests } from './chat-state';
import { resetDurableStoreStateForTests } from './durable-message-store';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

interface QueryCall {
  sql: string;
  params: unknown[];
}

type Rows = Record<string, unknown>[];

function stubPool(route: (sql: string, params: unknown[]) => Rows = () => []): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    try {
      const rows = route(sql, params);
      return Promise.resolve({ rows, rowCount: rows.length });
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return {
    calls,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg.Pool.prototype as any).query = original;
    },
  };
}

function useAccount(account: string): void {
  process.env.CONNECTOR_ACCOUNT = account;
  resetDurableStoreStateForTests();
  resetChatStateForTests();
}

const isResolve = (sql: string): boolean => /WITH RECURSIVE hop/.test(sql);
const isAliasResolve = (sql: string): boolean => /FROM social_contact_aliases a\s+JOIN conversations/.test(sql);
const isInsert = (sql: string): boolean => /INSERT INTO conversations/.test(sql);
const isWrite = (sql: string): boolean => /^\s*(INSERT|UPDATE|DELETE)|\bUPDATE\b|\bINSERT\b/i.test(sql);

const PHONE = '+34611111111';
const PN = '34611111111@s.whatsapp.net';
const PN_CUS = '34611111111@c.us';
const LID = '111@lid';

interface SockCalls {
  onWhatsApp: string[];
  lidLookups: string[];
  contacts: Array<[string, unknown]>;
  messages: Array<[string, unknown, unknown]>;
}

function makeClient(
  options: BaileysClientOptions = {},
  behaviour: { onWhatsApp?: (jid: string) => unknown[]; lid?: string | null } = {}
): { client: BaileysClient; calls: SockCalls } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const calls: SockCalls = { onWhatsApp: [], lidLookups: [], contacts: [], messages: [] };
  const sock: Record<string, unknown> = {
    ev: { on: () => {} },
    user: { id: '34600111222:5@s.whatsapp.net', lid: '900:5@lid' },
    onWhatsApp: async (jid: string) => {
      calls.onWhatsApp.push(jid);
      return behaviour.onWhatsApp ? behaviour.onWhatsApp(jid) : [{ jid, exists: true }];
    },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async (pn: string) => {
          calls.lidLookups.push(pn);
          return behaviour.lid === undefined ? `111:0@lid` : behaviour.lid;
        },
        getPNForLID: async () => null,
      },
    },
    addOrEditContact: async (jid: string, action: unknown) => {
      calls.contacts.push([jid, action]);
    },
    sendMessage: async (jid: string, content: unknown, opts: unknown) => {
      calls.messages.push([jid, content, opts]);
      return { key: { id: 'X1', remoteJid: jid, fromMe: true }, message: {} };
    },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean };
  internals.sock = sock;
  internals.ready = true;
  return { client, calls };
}

/** The DB of a test: which external ids resolve to which canonical conversation. */
function db(
  known: Record<string, { id: string; external_id: string }> = {},
  aliases: Record<string, { id: string; external_id: string }> = {},
  extra: (sql: string, params: unknown[]) => Rows | undefined = () => undefined
): (sql: string, params: unknown[]) => Rows {
  return (sql, params) => {
    const handled = extra(sql, params);
    if (handled) return handled;
    if (isResolve(sql)) {
      for (const candidate of (params[1] as string[]) || []) {
        if (known[candidate]) return [known[candidate]];
      }
      return [];
    }
    if (isAliasResolve(sql)) {
      for (const candidate of (params[1] as string[]) || []) {
        if (aliases[candidate]) return [aliases[candidate]];
      }
      return [];
    }
    if (/SELECT name FROM conversations/.test(sql)) return [{ name: 'Manu' }];
    if (isInsert(sql)) return [{ id: params[0] }];
    return [];
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

test('start chat input: a phone number (E.164 or 9 digits of the default country), message optional', () => {
  assert.deepEqual(parseStartChatRequest({ phone: '611 11 11 11' }).phone.phoneE164, PHONE);
  assert.equal(parseStartChatRequest({ phone: '+34611111111', message: '  hola ' }).message, 'hola');
  assert.equal(parseStartChatRequest({ phone: '+34611111111', message: '   ' }).message, undefined);
  for (const body of [
    {},
    { phone: '' },
    { phone: 'abc' },
    { phone: '123' },
    { phone: 34611111111 },
    { phone: PHONE, message: 5 },
    { phone: PHONE, message: 'x'.repeat(4097) },
  ]) {
    assert.throws(
      () => parseStartChatRequest(body),
      (e: unknown) => e instanceof MessageMutationError && e.status === 400 && e.failureClass === 'invalid_request',
      JSON.stringify(body).slice(0, 60)
    );
  }
});

test('create / share contact inputs: name and a phone number; share takes 1..5 cards', () => {
  assert.deepEqual(parseCreateContactRequest({ phone: '+34 611 111 111', name: ' Manu ' }), {
    phone: parseStartChatRequest({ phone: PHONE }).phone,
    name: 'Manu',
  });
  for (const body of [{ phone: PHONE }, { name: 'x' }, { phone: PHONE, name: 'x'.repeat(101) }]) {
    assert.throws(() => parseCreateContactRequest(body), (e: unknown) => e instanceof MessageMutationError && e.status === 400);
  }
  assert.deepEqual(parseShareContactRequest({ displayName: 'Manu', phone: '611111111', email: 'm@x.es' }), [
    { displayName: 'Manu', phone: PHONE, email: 'm@x.es' },
  ]);
  assert.equal(
    parseShareContactRequest({ contacts: [{ name: 'A', phone: PHONE }, { displayName: 'B', phone: '+447700900123' }] }).length,
    2
  );
  for (const body of [
    { contacts: [] },
    { contacts: 'x' },
    { contacts: Array.from({ length: 6 }, () => ({ displayName: 'A', phone: PHONE })) },
    { displayName: 'A' },
    { phone: PHONE },
    { displayName: 'A', phone: PHONE, email: 'not-an-email' },
  ]) {
    assert.throws(() => parseShareContactRequest(body), (e: unknown) => e instanceof MessageMutationError && e.status === 400, JSON.stringify(body).slice(0, 60));
  }
});

// ---------------------------------------------------------------------------
// vCards
// ---------------------------------------------------------------------------

test('vCard: escaped like RFC 6350 (\\ , ; newline), waid on the TEL line, one card or several', () => {
  assert.equal(vcardEscape('a\\b,c;d\ne\r\nf'), 'a\\\\b\\,c\\;d\\ne\\nf');
  const vcard = buildVcard({
    displayName: 'García, Manu; "el de\nlas réplicas"',
    phone: PHONE,
    organization: 'Skirm;shop',
    email: 'm@x.es',
  });
  assert.deepEqual(vcard.split('\n'), [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:;García\\, Manu\\; "el de\\nlas réplicas";;;',
    'FN:García\\, Manu\\; "el de\\nlas réplicas"',
    'ORG:Skirm\\;shop',
    'TEL;type=CELL;type=VOICE;waid=34611111111:+34611111111',
    'EMAIL;type=INTERNET:m@x.es',
    'END:VCARD',
  ]);
  // No line of the card can be forged through a value.
  assert.equal(vcard.split('\n').filter(line => line.startsWith('TEL')).length, 1);
  const one = buildContactShareContent([{ displayName: 'Manu', phone: PHONE }]);
  assert.equal(one.contacts.displayName, 'Manu');
  assert.equal(one.contacts.contacts.length, 1);
  const two = buildContactShareContent([
    { displayName: 'A', phone: PHONE },
    { displayName: 'B', phone: '+447700900123' },
  ]);
  assert.equal(two.contacts.displayName, '2 contactos');
  // Round trip: what we send reads back as the same card.
  assert.deepEqual(parseVcardView(null, vcard), {
    displayName: 'García, Manu; "el de\nlas réplicas"',
    phones: [PHONE],
    waids: ['34611111111'],
    organization: 'Skirm;shop',
  });
});

test('received vCards: names and numbers (waid first), folded lines, item prefixes, no raw vCard', () => {
  const vcard =
    'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Lo\r\n rena\r\nitem1.TEL:+1 (555) 010-0000\r\nitem2.TEL;waid=34622222222:+34 622 22 22 22\r\nEND:VCARD';
  assert.deepEqual(parseVcardView('', vcard), {
    displayName: 'Lorena',
    phones: ['+34622222222', '+15550100000'],
    waids: ['34622222222'],
  });
  assert.deepEqual(parseVcardView('Nombre', 'garbage'), { displayName: 'Nombre', phones: [], waids: [] });
  const shared = sharedContactsFromMessage({
    contactsArrayMessage: { displayName: null, contacts: [{ displayName: 'A', vcard }, { vcard: null }] },
  });
  assert.equal(shared?.displayName, '2 contactos');
  assert.equal(shared?.contacts[0].displayName, 'A');
  assert.equal(sharedContactsFromMessage({}), undefined);
});

test('an incoming contact message becomes a CONTACT row with metadata.contact', () => {
  const { client } = makeClient({ ingest: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const converted = (client as any).convertMessage({
    key: { id: 'C1', remoteJid: LID, fromMe: false },
    messageTimestamp: 1,
    message: { contactMessage: { displayName: 'Manu', vcard: buildVcard({ displayName: 'Manu', phone: PHONE }) } },
  });
  assert.equal(converted.messageType, 'CONTACT');
  assert.equal(converted.content, 'Manu');
  assert.deepEqual(converted.structured, {
    contact: { displayName: 'Manu', contacts: [{ displayName: 'Manu', phones: [PHONE], waids: ['34611111111'] }] },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gif = (client as any).convertMessage({
    key: { id: 'G1', remoteJid: LID, fromMe: true },
    messageTimestamp: 1,
    message: { videoMessage: { gifPlayback: true, caption: 'jaja' } },
  });
  assert.equal(gif.messageType, 'VIDEO');
  assert.deepEqual(gif.structured, { gifPlayback: true });
});

// ---------------------------------------------------------------------------
// Start chat: never a twin
// ---------------------------------------------------------------------------

test('start chat: the phone jid already has a conversation → that one, WhatsApp not asked, nothing written', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(db({ [PN_CUS]: { id: `professional:${PN_CUS}`, external_id: PN_CUS } }));
  const { client, calls: sock } = makeClient();
  try {
    const chat = await client.startChat(parseStartChatRequest({ phone: PHONE }).phone);
    assert.deepEqual(chat, {
      conversationId: `professional:${PN_CUS}`,
      chatId: PN_CUS,
      phone: PHONE,
      lid: null,
      name: 'Manu',
      created: false,
      existing: true,
      persisted: true,
    });
    assert.deepEqual(sock.onWhatsApp, []);
    assert.equal(calls.filter(c => isWrite(c.sql)).length, 0);
    // Both phone suffixes were looked up for this account.
    const resolve = calls.find(c => isResolve(c.sql))!;
    assert.deepEqual(resolve.params.slice(0, 2), ['whatsapp:professional', [PN_CUS, PN]]);
  } finally {
    restore();
  }
});

test('start chat: the phone is an alias of a LID conversation (merged twin) → the LID one', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(db({}, { [PN]: { id: `professional:${LID}`, external_id: LID } }));
  const { client, calls: sock } = makeClient();
  try {
    const chat = await client.startChat(parseStartChatRequest({ phone: PHONE }).phone);
    assert.equal(chat.conversationId, `professional:${LID}`);
    assert.equal(chat.chatId, LID);
    assert.equal(chat.lid, LID);
    assert.equal(chat.existing, true);
    assert.deepEqual(sock.onWhatsApp, []);
    assert.equal(calls.filter(c => isInsert(c.sql)).length, 0);
  } finally {
    restore();
  }
});

test('start chat: no alias, but WhatsApp’s LID for the number has a conversation → that one, no insert', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(db({ [LID]: { id: `professional:${LID}`, external_id: LID } }));
  const { client, calls: sock } = makeClient();
  try {
    const chat = await client.startChat(parseStartChatRequest({ phone: PHONE }).phone);
    assert.deepEqual(sock.onWhatsApp, [PN]);
    assert.deepEqual(sock.lidLookups, [PN]);
    assert.equal(chat.conversationId, `professional:${LID}`);
    assert.equal(chat.existing, true);
    assert.equal(calls.filter(c => isInsert(c.sql)).length, 0);
  } finally {
    restore();
  }
});

test('start chat: nothing exists → ONE row under the LID, phone in wa_chat_id (008 records the alias)', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(db());
  const { client } = makeClient();
  try {
    const chat = await client.startChat(parseStartChatRequest({ phone: PHONE }).phone);
    assert.deepEqual(chat, {
      conversationId: `professional:${LID}`,
      chatId: LID,
      phone: PHONE,
      lid: LID,
      name: PHONE,
      created: true,
      existing: false,
      persisted: true,
    });
    const inserts = calls.filter(c => isInsert(c.sql));
    assert.equal(inserts.length, 1);
    assert.match(inserts[0].sql, /wa_chat_id/);
    assert.match(inserts[0].sql, /ON CONFLICT \(id\) DO NOTHING/);
    assert.deepEqual(inserts[0].params, [
      `professional:${LID}`,
      PHONE,
      'professional',
      'whatsapp:professional',
      LID,
      `professional:${PN}`,
    ]);
  } finally {
    restore();
  }
});

test('start chat: no LID known → the row is the phone jid (@c.us), no wa_chat_id', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(db());
  const { client } = makeClient({}, { lid: null });
  try {
    const chat = await client.startChat(parseStartChatRequest({ phone: PHONE }).phone);
    assert.equal(chat.chatId, PN_CUS);
    assert.equal(chat.conversationId, PN_CUS, 'personal ids stay bare');
    const insert = calls.find(c => isInsert(c.sql))!;
    assert.doesNotMatch(insert.sql, /wa_chat_id/);
    assert.deepEqual(insert.params, [PN_CUS, PHONE, 'personal', 'whatsapp:personal', PN_CUS]);
  } finally {
    restore();
  }
});

test('start chat: wa_chat_id already taken by another row (UNIQUE) → the row without it', async () => {
  useAccount('professional');
  let first = true;
  const { calls, restore } = stubPool(
    db({}, {}, sql => {
      if (isInsert(sql) && /wa_chat_id/.test(sql) && first) {
        first = false;
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      return undefined;
    })
  );
  const { client } = makeClient();
  try {
    const chat = await client.startChat(parseStartChatRequest({ phone: PHONE }).phone);
    assert.equal(chat.created, true);
    assert.equal(calls.filter(c => isInsert(c.sql)).length, 2);
  } finally {
    restore();
  }
});

test('start chat: not on WhatsApp → 422 not_on_whatsapp, nothing written', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(db());
  const { client } = makeClient({}, { onWhatsApp: () => [] });
  try {
    await assert.rejects(
      client.startChat(parseStartChatRequest({ phone: PHONE }).phone),
      (e: unknown) => e instanceof MessageMutationError && e.status === 422 && e.failureClass === 'not_on_whatsapp'
    );
    assert.equal(calls.filter(c => isWrite(c.sql)).length, 0);
  } finally {
    restore();
  }
});

test('start chat with ingest off (pairing pool): WhatsApp asked, the DB never touched', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(db());
  const { client, calls: sock } = makeClient({ ingest: false });
  try {
    const chat = await client.startChat(parseStartChatRequest({ phone: PHONE }).phone);
    assert.deepEqual(sock.onWhatsApp, [PN]);
    assert.equal(chat.persisted, false);
    assert.equal(chat.conversationId, null);
    assert.equal(chat.chatId, LID);
    assert.deepEqual(calls, []);
    assert.deepEqual(await client.listContacts(), []);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

test('contact list rows: phone only from a phone jid (never LID digits), jid-like names dropped', () => {
  assert.equal(phoneFromUserJid('professional:34611111111@c.us'), PHONE);
  assert.equal(phoneFromUserJid(PN), PHONE);
  assert.equal(phoneFromUserJid(LID), undefined);
  assert.equal(phoneFromUserJid('120363@g.us'), undefined);
  assert.equal(isJidLikeName('34611111111@c.us'), true);
  assert.equal(isJidLikeName('+34 611 11 11 11'), true);
  assert.equal(isJidLikeName('Manu 2'), false);
  assert.deepEqual(
    contactEntryFromRow({
      person: LID,
      jids: [LID, PN_CUS, PN, LID],
      name: '111@lid',
      push_name: 'Manu',
      conversation_id: `professional:${LID}`,
      last_activity: new Date(5),
    }),
    {
      id: LID,
      name: null,
      pushName: 'Manu',
      phone: PHONE,
      jids: [LID, PN_CUS, PN].sort(),
      conversationId: `professional:${LID}`,
      lastActivityAt: new Date(5).toISOString(),
    }
  );
  assert.equal(
    contactEntryFromRow({ person: LID, jids: [LID], name: 'Lo', push_name: null, conversation_id: null, last_activity: null }).phone,
    null,
    'a LID-only person has no phone'
  );
});

test('contact list query: this account, aliases folded (blocked ignored), own jids out, search and limit bound', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(() => [
    { person: LID, jids: [LID, PN], name: 'Manu', push_name: null, conversation_id: `professional:${LID}`, last_activity: null },
  ]);
  try {
    const contacts = await listAccountContacts({
      query: ' 611 11%_ ',
      limit: 9999,
      ownJids: ['34600111222@s.whatsapp.net', '900@lid'],
    });
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].phone, PHONE);
    const { sql, params } = calls[0];
    assert.match(sql, /evidence <> 'blocked'/);
    assert.match(sql, /merged_into IS NULL/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\b/);
    assert.deepEqual(params, [
      'whatsapp:professional',
      ['34600111222@s.whatsapp.net', '34600111222@c.us', '900@lid'],
      '611 11%_',
      '%611 11\\%\\_%',
      '61111',
      500,
    ]);
  } finally {
    restore();
  }
});

test('create contact: WhatsApp’s address-book mutation (PN index, LID, saveOnPrimaryAddressbook), name on existing rows only', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(sql => (/WITH p AS/.test(sql) ? [{ changed: 2 }] : []));
  const { client, calls: sock } = makeClient();
  try {
    const request = parseCreateContactRequest({ phone: PHONE, name: 'Manu' });
    const contact = await client.createContact(request, { actor: 'dani' });
    assert.deepEqual(contact, {
      phone: PHONE,
      jid: PN_CUS,
      lid: LID,
      name: 'Manu',
      addressBookSync: true,
      persisted: true,
    });
    assert.deepEqual(sock.contacts, [
      [PN, { fullName: 'Manu', firstName: 'Manu', pnJid: PN, lidJid: LID, saveOnPrimaryAddressbook: true }],
    ]);
    assert.equal(calls.filter(c => /INSERT/.test(c.sql)).length, 0, 'no row is created');
    assert.deepEqual(calls[0].params, ['whatsapp:professional', [PN, PN_CUS, LID], 'Manu']);
  } finally {
    restore();
  }
});

test('create contact: not on WhatsApp → 422 before any mutation; ingest off never writes', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool();
  try {
    const missing = makeClient({}, { onWhatsApp: () => [{ jid: PN, exists: false }] });
    await assert.rejects(
      missing.client.createContact(parseCreateContactRequest({ phone: PHONE, name: 'Manu' })),
      (e: unknown) => e instanceof MessageMutationError && e.failureClass === 'not_on_whatsapp'
    );
    assert.deepEqual(missing.calls.contacts, []);
    const pairing = makeClient({ ingest: false });
    const contact = await pairing.client.createContact(parseCreateContactRequest({ phone: PHONE, name: 'Manu' }));
    assert.equal(contact.persisted, false);
    assert.equal(pairing.calls.contacts.length, 1);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('share contact: a vCard to the chat’s canonical jid (the LID of a merged phone chat)', async () => {
  useAccount('professional');
  const { restore } = stubPool(db({ [PN_CUS]: { id: `professional:${LID}`, external_id: LID } }));
  const { client, calls: sock } = makeClient();
  try {
    const result = await client.shareContacts(`professional:${PN_CUS}`, [
      { displayName: 'Manu', phone: '+34622222222' },
    ]);
    assert.equal(result.messageId, 'X1');
    assert.equal(result.contacts, 1);
    const [jid, content] = sock.messages[0];
    assert.equal(jid, LID);
    const card = (content as { contacts: { contacts: Array<{ vcard: string }> } }).contacts.contacts[0];
    assert.match(card.vcard, /TEL;type=CELL;type=VOICE;waid=34622222222:\+34622222222/);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Call = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
) => Promise<globalThis.Response>;

async function withRouter(
  client: Partial<BaileysClient>,
  env: Record<string, string | undefined>,
  run: (call: Call) => Promise<void>
): Promise<void> {
  const secret = 'test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client as BaileysClient, { getCurrentQR: () => null } as never, secret));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const call: Call = (method, path, body, headers = {}) => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(ts),
        'x-connector-signature': generateHMACSignature(body ?? {}, ts, secret),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await run(call);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
}

const CHAT = {
  conversationId: `professional:${LID}`,
  chatId: LID,
  phone: PHONE,
  lid: LID,
  name: 'Manu',
  created: true,
  existing: false,
  persisted: true,
};

function recordingClient(connected = true): { client: Partial<BaileysClient>; seen: unknown[] } {
  const seen: unknown[] = [];
  const client = {
    isConnected: () => connected,
    isIngestEnabled: () => false,
    getCachedState: () => (connected ? 'CONNECTED' : 'CLOSED:428'),
    startChat: async (phone: { phoneE164: string }, options?: { actor?: string }) => {
      seen.push({ start: phone.phoneE164, ...options });
      return CHAT as never;
    },
    sendMessage: async (chatId: string, content: string) => {
      seen.push({ send: chatId, content });
      return 'M1';
    },
    listContacts: async (options: unknown) => {
      seen.push({ list: options });
      return [{ id: LID, phone: PHONE }] as never;
    },
    createContact: async (input: { name: string }, options?: { actor?: string }) => {
      seen.push({ create: input.name, ...options });
      return { name: input.name } as never;
    },
    shareContacts: async (chatId: string, cards: unknown[]) => {
      seen.push({ share: chatId, cards: cards.length });
      return { messageId: 'S1', conversationId: LID, sentAt: 'now', contacts: cards.length } as never;
    },
  };
  return { client: client as unknown as Partial<BaileysClient>, seen };
}

const ON = { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined };

test('HTTP: the sending gate blocks start / create / share, not the list; 400s come first', async () => {
  const { client, seen } = recordingClient();
  for (const env of [
    { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: undefined, EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' },
  ]) {
    await withRouter(client, env, async call => {
      for (const [path, body] of [
        ['/chats/start', { phone: PHONE }],
        ['/chats/start', { phone: PHONE, message: 'hola' }],
        ['/contacts/create', { phone: PHONE, name: 'Manu' }],
        ['/contacts', { phone: PHONE, name: 'Manu' }],
        ['/contacts/share', { conversationId: LID, displayName: 'Manu', phone: PHONE }],
      ] as const) {
        const res = await call('POST', path, body);
        assert.equal(res.status, 403, path);
        assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'disabled_sending');
      }
      for (const [path, body] of [
        ['/chats/start', { phone: 'nope' }],
        ['/chats/start', {}],
        ['/contacts/create', { phone: PHONE }],
        ['/contacts/share', { displayName: 'Manu', phone: PHONE }],
        ['/contacts/share', { conversationId: LID, contacts: [] }],
      ] as const) {
        const res = await call('POST', path, body);
        assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
        assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'invalid_request');
      }
      const list = await call('GET', '/contacts?q=man&limit=20');
      assert.equal(list.status, 200);
      assert.equal(((await list.json()) as { count: number }).count, 1);
      assert.equal((await call('GET', '/contacts?limit=0')).status, 400);
    });
  }
  assert.deepEqual(seen, [
    { list: { query: 'man', limit: 20 } },
    { list: { query: 'man', limit: 20 } },
    { list: { query: 'man', limit: 20 } },
  ]);
});

test('HTTP: bad or missing signature is 401 before anything', async () => {
  const { client, seen } = recordingClient();
  // withRouter always signs: this one calls the server by hand.
  const secret = 'test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client as BaileysClient, { getCurrentQR: () => null } as never, secret));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const body = { phone: PHONE };
    const tampered = await fetch(`http://127.0.0.1:${port}/api/v1/chats/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(ts),
        'x-connector-signature': generateHMACSignature({ phone: '+34699999999' }, ts, secret),
      },
      body: JSON.stringify(body),
    });
    assert.equal(tampered.status, 401);
    const unsigned = await fetch(`http://127.0.0.1:${port}/api/v1/contacts`);
    assert.equal(unsigned.status, 401);
    const stale = await fetch(`http://127.0.0.1:${port}/api/v1/contacts`, {
      headers: {
        'x-connector-timestamp': String(ts - 3600),
        'x-connector-signature': generateHMACSignature({}, ts - 3600, secret),
      },
    });
    assert.equal(stale.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.deepEqual(seen, []);
});

test('HTTP: start chat answers the chat; the first message goes to the chat’s own jid', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async call => {
    const bare = await call('POST', '/chats/start', { phone: '611111111', actor: 'dani' });
    assert.deepEqual(await bare.json(), { started: true, chat: CHAT });
    const withMessage = await call('POST', '/chats/start', { phone: PHONE, message: ' hola ' });
    const answer = (await withMessage.json()) as { message: { sent: boolean; messageId: string } };
    assert.equal(answer.message.sent, true);
    assert.equal(answer.message.messageId, 'M1');
  });
  assert.deepEqual(seen, [
    { start: PHONE, actor: 'dani' },
    { start: PHONE, actor: undefined },
    { send: LID, content: 'hola' },
  ]);
});

test('HTTP: not on WhatsApp is 422; a failed first message keeps the chat in the answer; 503 offline', async () => {
  const failing = {
    ...recordingClient().client,
    startChat: async () => {
      throw new MessageMutationError(`${PHONE} is not on WhatsApp`, 422, 'not_on_whatsapp');
    },
  };
  await withRouter(failing as never, ON, async call => {
    const res = await call('POST', '/chats/start', { phone: PHONE });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: `${PHONE} is not on WhatsApp`, failureClass: 'not_on_whatsapp' });
  });
  const sendFails = {
    ...recordingClient().client,
    sendMessage: async () => {
      throw Object.assign(new Error('Client not connected (state=CLOSED)'), {});
    },
  };
  await withRouter(sendFails as never, ON, async call => {
    const res = await call('POST', '/chats/start', { phone: PHONE, message: 'hola' });
    assert.notEqual(res.status, 200);
    const body = (await res.json()) as { started: boolean; chat: unknown; message: { sent: boolean } };
    assert.equal(body.started, true);
    assert.deepEqual(body.chat, CHAT);
    assert.equal(body.message.sent, false);
  });
  const offline = recordingClient(false);
  await withRouter(offline.client, ON, async call => {
    for (const [path, body] of [
      ['/chats/start', { phone: PHONE }],
      ['/contacts/create', { phone: PHONE, name: 'Manu' }],
      ['/contacts/share', { conversationId: LID, displayName: 'Manu', phone: PHONE }],
    ] as const) {
      const res = await call('POST', path, body);
      assert.equal(res.status, 503, path);
    }
  });
  assert.deepEqual(offline.seen, []);
});

test('HTTP: create contact and share answer their shapes (POST /contacts is create)', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async call => {
    assert.deepEqual(await (await call('POST', '/contacts', { phone: PHONE, name: 'Manu', actor: 'dani' })).json(), {
      created: true,
      contact: { name: 'Manu' },
    });
    assert.deepEqual(
      await (await call('POST', '/contacts/share', {
        conversationId: LID,
        contacts: [{ displayName: 'A', phone: PHONE }, { displayName: 'B', phone: '+447700900123' }],
      })).json(),
      { sent: true, messageId: 'S1', conversationId: LID, sentAt: 'now', contacts: 2 }
    );
  });
  assert.deepEqual(seen, [
    { create: 'Manu', actor: 'dani' },
    { share: LID, cards: 2 },
  ]);
});
