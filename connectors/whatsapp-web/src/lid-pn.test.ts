/**
 * Tests for the WhatsApp LID → phone-number (PN) capture path (prod 2026-06-11).
 *
 * WhatsApp's privacy migration re-addresses 1:1 chats with opaque LID jids
 * (`<lid>@lid`). The LID is NOT a phone number, so the legacy "digits before @"
 * extraction produced garbage for skirmshop-labels' opt-in poller, which keys on
 * the real MSISDN. Baileys surfaces the real phone-number jid alongside the LID
 * (the EXACT field name has moved across releases — see pnFromLidMessage), and
 * the connector now persists it as:
 *   1. messages.metadata->>'senderPnE164'  (E.164 with '+', the consumer key)
 *   2. conversations.wa_chat_id            (the bare PN jid, namespaced by account)
 * …without ever re-keying the LID-addressed conversation/message ids and without
 * inventing a number when none is present.
 *
 * The pure extraction (pnFromLidMessage/pnJidToE164) is asserted directly; the
 * DB-side contract is asserted by stubbing pg.Pool#query and inspecting the
 * SQL + bound params, exactly like db-writer.test.ts / read-paths.test.ts.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

/** Stub pg.Pool#query; capture (sql, params), mimic INSERT ... RETURNING id. */
function stubPoolQuery(): { calls: CapturedQuery[]; restore: () => void } {
  const calls: CapturedQuery[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    return Promise.resolve({ rows: [{ id: 1n }] });
  };
  return {
    calls,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg.Pool.prototype as any).query = original;
    },
  };
}

async function loadWriter(account: string): Promise<typeof import('./db-writer.js')> {
  process.env.CONNECTOR_ACCOUNT = account;
  return (await import('./db-writer.ts')) as typeof import('./db-writer.js');
}

async function loadClientModule(): Promise<typeof import('./baileys-client.js')> {
  return (await import('./baileys-client.ts')) as typeof import('./baileys-client.js');
}

const tableOf = (sql: string): string => {
  const m = /insert into (\w+)|update (\w+)/i.exec(sql);
  return ((m && (m[1] || m[2])) || '').toLowerCase();
};
const findInsert = (calls: CapturedQuery[], table: string): CapturedQuery | undefined =>
  calls.find(c => /insert into/i.test(c.sql) && tableOf(c.sql) === table);
const findUpdate = (calls: CapturedQuery[], table: string): CapturedQuery | undefined =>
  calls.find(c => /update/i.test(c.sql) && tableOf(c.sql) === table);

// The exact prod message (CLAUDE context): a live LID-addressed chat.
const PROD_LID_JID = '174869610295503@lid';
// The real phone behind it, as Baileys would attach it (PN jid).
const PN_JID = '34659695630@s.whatsapp.net';
const PN_E164 = '+34659695630';

// ---------------------------------------------------------------------------
// pnJidToE164: phone-number jid → E.164, never fabricates
// ---------------------------------------------------------------------------

test('pnJidToE164 derives +E164 from a phone-number jid (incl. device suffix)', async () => {
  const { pnJidToE164 } = await loadClientModule();
  assert.equal(pnJidToE164(PN_JID), PN_E164);
  assert.equal(pnJidToE164('34659695630:3@s.whatsapp.net'), PN_E164, 'strips :device suffix');
  assert.equal(pnJidToE164('34659695630@c.us'), PN_E164, 'accepts legacy @c.us PN form');
});

test('pnJidToE164 returns undefined for non-PN / non-numeric jids (never invents a number)', async () => {
  const { pnJidToE164 } = await loadClientModule();
  assert.equal(pnJidToE164(PROD_LID_JID), undefined, 'a @lid jid is opaque, not a phone');
  assert.equal(pnJidToE164('1234567890@g.us'), undefined, 'group jid is not a phone');
  assert.equal(pnJidToE164('abc@s.whatsapp.net'), undefined, 'non-numeric user');
  assert.equal(pnJidToE164(''), undefined);
  assert.equal(pnJidToE164(undefined), undefined);
  assert.equal(pnJidToE164(null), undefined);
});

// ---------------------------------------------------------------------------
// pnFromLidMessage: only fires on @lid + a real PN, across Baileys field names
// ---------------------------------------------------------------------------

test('pnFromLidMessage extracts PN from key.remoteJidAlt (Baileys 7.x, 1:1 LID chat)', async () => {
  const { pnFromLidMessage } = await loadClientModule();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg: any = { key: { remoteJid: PROD_LID_JID, fromMe: false, id: 'X', remoteJidAlt: PN_JID } };
  assert.deepEqual(pnFromLidMessage(msg), { pnJid: PN_JID, e164: PN_E164 });
});

test('pnFromLidMessage extracts PN from key.participantAlt (group LID sender)', async () => {
  const { pnFromLidMessage } = await loadClientModule();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg: any = {
    key: { remoteJid: '120363@g.us', participant: PROD_LID_JID, fromMe: false, id: 'X', participantAlt: PN_JID },
  };
  assert.deepEqual(pnFromLidMessage(msg), { pnJid: PN_JID, e164: PN_E164 });
});

test('pnFromLidMessage extracts PN from key.senderPn / msg.senderPn (6.17.x variants)', async () => {
  const { pnFromLidMessage } = await loadClientModule();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keyPn: any = { key: { remoteJid: PROD_LID_JID, fromMe: false, id: 'X', senderPn: PN_JID } };
  assert.deepEqual(pnFromLidMessage(keyPn), { pnJid: PN_JID, e164: PN_E164 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topPn: any = { key: { remoteJid: PROD_LID_JID, fromMe: false, id: 'X' }, senderPn: PN_JID };
  assert.deepEqual(pnFromLidMessage(topPn), { pnJid: PN_JID, e164: PN_E164 });
});

test('pnFromLidMessage returns undefined for a LID chat with NO phone attached', async () => {
  const { pnFromLidMessage } = await loadClientModule();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg: any = { key: { remoteJid: PROD_LID_JID, fromMe: false, id: 'X' } };
  assert.equal(pnFromLidMessage(msg), undefined, 'no PN field => no guess');
});

test('pnFromLidMessage ignores an alt that is itself a LID (not a phone)', async () => {
  const { pnFromLidMessage } = await loadClientModule();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg: any = { key: { remoteJid: PROD_LID_JID, fromMe: false, id: 'X', remoteJidAlt: '999@lid' } };
  assert.equal(pnFromLidMessage(msg), undefined);
});

test('pnFromLidMessage returns undefined for a normal @s.whatsapp.net / @c.us chat', async () => {
  const { pnFromLidMessage } = await loadClientModule();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const net: any = { key: { remoteJid: PN_JID, fromMe: false, id: 'X' } };
  assert.equal(pnFromLidMessage(net), undefined, 'phone-addressed chat needs no side-channel');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cus: any = { key: { remoteJid: '34659695630@c.us', fromMe: false, id: 'X' } };
  assert.equal(pnFromLidMessage(cus), undefined);
});

test('lidFromPnMessage accepts only a direct PN with Baileys LID alternate', async () => {
  const { lidFromPnMessage } = await loadClientModule();
  assert.equal(lidFromPnMessage({ key: { remoteJid: PN_JID, remoteJidAlt: PROD_LID_JID } } as any), PROD_LID_JID);
  assert.equal(lidFromPnMessage({ key: { remoteJid: PN_JID, remoteJidAlt: '123456789:2@lid' } } as any), '123456789@lid');
  assert.equal(lidFromPnMessage({ key: { remoteJid: PN_JID, remoteJidAlt: PN_JID } } as any), undefined);
  assert.equal(lidFromPnMessage({ key: { remoteJid: PROD_LID_JID, remoteJidAlt: '123456789@lid' } } as any), undefined);
  assert.equal(lidFromPnMessage({ key: { remoteJid: '120363@g.us', remoteJidAlt: PROD_LID_JID } } as any), undefined);
});

test('contact identity keeps address-book name separate from push name and aliases', async () => {
  const { whatsappContactIdentity } = await loadClientModule();
  assert.deepEqual(
    whatsappContactIdentity({
      id: '123456789012345@lid',
      phoneNumber: '34600111222@s.whatsapp.net',
      name: 'Agenda',
      notify: 'Perfil',
    }),
    {
      ids: ['123456789012345@lid', '34600111222@s.whatsapp.net'],
      name: 'Agenda',
      pushName: 'Perfil',
    }
  );
});

test('saved contact names outrank push names while later saved names replace them', async () => {
  const { preferWhatsAppContactName } = await loadClientModule();
  const saved = { name: 'Agenda', source: 'saved' as const };
  const push = { name: 'Perfil', source: 'push' as const };
  const renamed = { name: 'Nueva agenda', source: 'saved' as const };

  assert.deepEqual(preferWhatsAppContactName(undefined, push), push);
  assert.deepEqual(preferWhatsAppContactName(saved, push), saved);
  assert.deepEqual(preferWhatsAppContactName(push, saved), saved);
  assert.deepEqual(preferWhatsAppContactName(saved, renamed), renamed);
});

test('conversation-name selection never uses a participant name as a group title', async () => {
  const {
    chooseWhatsAppConversationName,
    isWhatsAppJidLikeName,
  } = await loadClientModule();
  const lid = '123456789012345@lid';
  assert.equal(isWhatsAppJidLikeName('professional:123456789012345@lid', lid), true);
  assert.equal(isWhatsAppJidLikeName('Agenda', lid), false);
  assert.equal(
    chooseWhatsAppConversationName({
      id: lid,
      isGroup: false,
      existingName: lid,
      pushName: 'Perfil',
    }),
    'Perfil'
  );
  assert.equal(
    chooseWhatsAppConversationName({
      id: '120363@g.us',
      isGroup: true,
      existingName: '120363@g.us',
      contactName: 'Participante',
      pushName: 'Perfil',
      groupSubject: 'Equipo',
    }),
    'Equipo'
  );
});

test('contact name priority survives push-only updates and allows saved renames', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    process.env.CONNECTOR_ACCOUNT = 'personal';
    const { BaileysClient } = await loadClientModule();
    const chatId = '34600111222@c.us';
    const seedClient = (name: string) => {
      const client = new BaileysClient('/tmp/socialmedia-contact-name-test', 'test-key');
      const chatStore = (client as any).chatStore as Map<string, any>;
      chatStore.set(chatId, {
        id: chatId,
        rawJid: '34600111222@s.whatsapp.net',
        name,
        isGroup: false,
        unreadCount: 0,
        timestamp: 0,
      });
      return { client, chatStore };
    };
    const first = seedClient(chatId);
    const client = first.client;
    const chatStore = first.chatStore;
    const apply = (contact: unknown) => (client as any).applyContactIdentity(contact);
    const flush = async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    };

    apply({ id: '34600111222@s.whatsapp.net', name: 'Agenda', notify: 'Perfil' });
    await flush();
    assert.equal(chatStore.get(chatId).name, 'Agenda');
    let conversationUpdates = calls.filter(call => /^\s*UPDATE conversations/i.test(call.sql));
    assert.equal(conversationUpdates.length, 1);
    assert.equal(conversationUpdates[0].params[4], true);

    // A reconnect starts with an empty contact cache. A later notify-only
    // event is still a fallback and must leave the saved title intact.
    const restarted = seedClient('Agenda');
    const applyAfterRestart = (contact: unknown) =>
      (restarted.client as any).applyContactIdentity(contact);
    applyAfterRestart({ id: '34600111222@s.whatsapp.net', notify: 'Perfil nuevo' });
    await flush();
    assert.equal(restarted.chatStore.get(chatId).name, 'Agenda');
    conversationUpdates = calls.filter(call => /^\s*UPDATE conversations/i.test(call.sql));
    assert.equal(conversationUpdates.length, 2);
    assert.equal(conversationUpdates[1].params[2], 'Perfil nuevo');
    assert.equal(conversationUpdates[1].params[4], false);

    applyAfterRestart({
      id: '34600111222@s.whatsapp.net',
      name: 'Agenda nueva',
      notify: 'Perfil nuevo',
    });
    await flush();
    assert.equal(restarted.chatStore.get(chatId).name, 'Agenda nueva');
    conversationUpdates = calls.filter(call => /^\s*UPDATE conversations/i.test(call.sql));
    assert.equal(conversationUpdates.length, 3);
    assert.equal(conversationUpdates[2].params[2], 'Agenda nueva');
    assert.equal(conversationUpdates[2].params[4], true);
  } finally {
    restore();
  }
});

test('saved contact rename persists before chat hydration', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    process.env.CONNECTOR_ACCOUNT = 'personal';
    const { BaileysClient } = await loadClientModule();
    const client = new BaileysClient('/tmp/socialmedia-contact-name-before-chat-test', 'test-key');
    (client as any).applyContactIdentity({
      id: '34600111222@s.whatsapp.net',
      name: 'Agenda inicial',
      notify: 'Perfil',
    });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();

    const updates = calls.filter(call => /^\s*UPDATE conversations/i.test(call.sql));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].params[2], 'Agenda inicial');
    assert.equal(updates[0].params[4], true);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// storeMessage: senderPnE164 rides in metadata iff present (LID + PN)
// ---------------------------------------------------------------------------

const metadataOf = (q: CapturedQuery): Record<string, unknown> => {
  // db-writer binds JSON.stringify(metadata) as the 11th param ($11).
  const raw = q.params[10];
  return JSON.parse(String(raw)) as Record<string, unknown>;
};

test('LID + senderPn: storeMessage persists metadata.senderPnE164 (consumer key)', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('professional');
    await w.storeMessage({
      waMessageId: '3EB0LID',
      conversationId: PROD_LID_JID, // conversation id STAYS the LID
      senderWaId: PROD_LID_JID,
      waTimestamp: new Date(),
      direction: 'INBOUND',
      content: 'BAJA',
      messageType: 'TEXT',
      isForwarded: false,
      metadata: { source: 'live', senderPnE164: PN_E164 },
    });
    const msg = findInsert(calls, 'messages')!;
    const meta = metadataOf(msg);
    assert.equal(meta.senderPnE164, PN_E164, 'senderPnE164 must be persisted in metadata');
    // The conversation id stays the namespaced LID — we never re-key it.
    assert.equal(msg.params[1], `professional:${PROD_LID_JID}`);
  } finally {
    restore();
  }
});

test('LID without senderPn: storeMessage omits the senderPnE164 key entirely (no fabrication)', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('professional');
    await w.storeMessage({
      waMessageId: '3EB0LID2',
      conversationId: PROD_LID_JID,
      senderWaId: PROD_LID_JID,
      waTimestamp: new Date(),
      direction: 'INBOUND',
      content: 'hola',
      messageType: 'TEXT',
      isForwarded: false,
      // mirrors ingestMessage: lidPn?.e164 is undefined -> key dropped by JSON.stringify
      metadata: { source: 'live', senderPnE164: undefined },
    });
    const meta = metadataOf(findInsert(calls, 'messages')!);
    assert.equal('senderPnE164' in meta, false, 'absent PN must leave no senderPnE164 key');
  } finally {
    restore();
  }
});

test('normal @c.us message: storeMessage carries no senderPnE164 (unchanged behaviour)', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('personal');
    await w.storeMessage({
      waMessageId: '3EB0CUS',
      conversationId: '34659695630@c.us',
      senderWaId: '34659695630@c.us',
      waTimestamp: new Date(),
      direction: 'INBOUND',
      content: 'hi',
      messageType: 'TEXT',
      isForwarded: false,
      metadata: { source: 'live', senderPnE164: undefined },
    });
    const meta = metadataOf(findInsert(calls, 'messages')!);
    assert.equal('senderPnE164' in meta, false);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// setConversationWaChatId: the alias transfer must be atomic and account scoped
// ---------------------------------------------------------------------------

function stubBackfill(initial: { id: string; account: string; wa_chat_id: string | null; is_group?: boolean }[]) {
  const rows = initial.map(row => ({ ...row }));
  const calls: CapturedQuery[] = [];
  const original = pg.Pool.prototype.connect;
  let snapshot: typeof rows = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).connect = async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql === 'BEGIN') { snapshot = rows.map(row => ({ ...row })); return { rows: [] }; }
      if (sql === 'ROLLBACK') { rows.splice(0, rows.length, ...snapshot); return { rows: [] }; }
      if (sql === 'COMMIT') return { rows: [] };
      if (/SELECT wa_chat_id FROM conversations/.test(sql)) {
        const row = rows.find(row => row.id === params[0] && row.account === params[1] && !row.is_group);
        return { rows: row ? [{ wa_chat_id: row.wa_chat_id }] : [] };
      }
      if (/SELECT id, account, is_group FROM conversations/.test(sql)) {
        const row = rows.find(row => row.wa_chat_id === params[0]);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (/SET wa_chat_id = NULL/.test(sql)) {
        const row = rows.find(row => row.id === params[0] && row.account === params[1] && row.wa_chat_id === params[2] && !row.is_group);
        if (row) row.wa_chat_id = null;
        return { rows: [] };
      }
      if (/SET wa_chat_id = \$2/.test(sql)) {
        const row = rows.find(row => row.id === params[0] && row.account === params[2] && !row.is_group);
        if (row && (!row.wa_chat_id || row.wa_chat_id === row.id)) {
          if (rows.some(other => other !== row && other.wa_chat_id === params[1])) throw Object.assign(new Error('unique violation'), { code: '23505' });
          row.wa_chat_id = String(params[1]);
        }
        return { rows: [] };
      }
      throw new Error('Unexpected backfill query');
    },
    release: () => { calls.push({ sql: 'RELEASE', params: [] }); },
  });
  return { rows, calls, restore: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg.Pool.prototype as any).connect = original;
  } };
}

test('professional setConversationWaChatId namespaces both the WHERE id and the stored value', async () => {
  const { rows, calls, restore } = stubBackfill([{ id: `professional:${PROD_LID_JID}`, account: 'professional', wa_chat_id: null }]);
  try {
    const w = await loadWriter('professional');
    await w.setConversationWaChatId(PROD_LID_JID, PN_JID);
    const u = calls.find(call => /SET wa_chat_id = \$2/.test(call.sql))!;
    assert.equal(u.params[0], `professional:${PROD_LID_JID}`, 'WHERE id is the namespaced LID row');
    assert.equal(
      u.params[1],
      `professional:${PN_JID}`,
      'stored wa_chat_id is namespaced (UNIQUE col shared across accounts — PR #22)'
    );
    // Only backfills: must guard against clobbering an existing non-empty value.
    assert.match(u.sql, /wa_chat_id IS NULL OR wa_chat_id = ''/i);
    assert.equal(rows[0].wa_chat_id, `professional:${PN_JID}`);
    assert.deepEqual(calls.map(call => call.sql).filter(sql => ['BEGIN', 'COMMIT', 'RELEASE'].includes(sql)), ['BEGIN', 'COMMIT', 'RELEASE']);
  } finally {
    restore();
  }
});

test('personal setConversationWaChatId keeps both id and value bare', async () => {
  const { rows, calls, restore } = stubBackfill([{ id: PROD_LID_JID, account: 'personal', wa_chat_id: null }]);
  try {
    const w = await loadWriter('personal');
    await w.setConversationWaChatId(PROD_LID_JID, PN_JID);
    const u = calls.find(call => /SET wa_chat_id = \$2/.test(call.sql))!;
    assert.equal(u.params[0], PROD_LID_JID);
    assert.equal(u.params[1], PN_JID);
    assert.equal(rows[0].wa_chat_id, PN_JID);
  } finally {
    restore();
  }
});

test('backfill frees only the matching PN alias before assigning its LID in one transaction', async () => {
  const lid = `professional:${PROD_LID_JID}`;
  const pn = `professional:${PN_JID}`;
  const pnAlias = pn.replace('@s.whatsapp.net', '@c.us');
  const other = 'professional:999999@s.whatsapp.net';
  const { rows, calls, restore } = stubBackfill([
    { id: lid, account: 'professional', wa_chat_id: null },
    { id: pnAlias, account: 'professional', wa_chat_id: pn },
    { id: other, account: 'professional', wa_chat_id: other },
  ]);
  try {
    const w = await loadWriter('professional');
    await w.setConversationWaChatId(PROD_LID_JID, PN_JID);
    assert.equal(rows[0].wa_chat_id, pn);
    assert.equal(rows[1].wa_chat_id, null);
    assert.equal(rows[1].id, pnAlias, 'PN row remains for audit');
    assert.equal(rows[2].wa_chat_id, other);
    const clear = calls.findIndex(call => /SET wa_chat_id = NULL/.test(call.sql));
    const assign = calls.findIndex(call => /SET wa_chat_id = \$2/.test(call.sql));
    assert.ok(clear > 0 && assign > clear);
    assert.ok(calls.find(call => /SELECT id, account, is_group FROM conversations.*FOR UPDATE/.test(call.sql)));
  } finally { restore(); }
});

test('backfill leaves another account or unrelated owner untouched', async () => {
  for (const owner of [
    { id: `personal:${PN_JID}`, account: 'personal', wa_chat_id: `professional:${PN_JID}` },
    { id: 'professional:888888@c.us', account: 'professional', wa_chat_id: `professional:${PN_JID}` },
  ]) {
    const { rows, calls, restore } = stubBackfill([
      { id: `professional:${PROD_LID_JID}`, account: 'professional', wa_chat_id: null }, owner,
    ]);
    try {
      const w = await loadWriter('professional');
      await w.setConversationWaChatId(PROD_LID_JID, PN_JID);
      assert.equal(rows[0].wa_chat_id, null);
      assert.equal(rows[1].wa_chat_id, `professional:${PN_JID}`);
      assert.equal(calls.some(call => /SET wa_chat_id = NULL/.test(call.sql)), false);
    } finally { restore(); }
  }
});

test('LID ingest waits for alias backfill before durable payload and message writes', async () => {
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const originalQuery = pg.Pool.prototype.query;
  const originalConnect = pg.Pool.prototype.connect;
  const calls: string[] = [];
  const conversationIds: string[] = [];
  let targetSelections = 0;
  let releaseTarget!: () => void;
  let targetSelected!: () => void;
  const targetGate = new Promise<void>(resolve => { releaseTarget = resolve; });
  const selected = new Promise<void>(resolve => { targetSelected = resolve; });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = async (sql: string, params: unknown[] = []) => {
    calls.push(sql);
    if (/INSERT INTO conversations\b/.test(sql)) conversationIds.push(String(params[0]));
    return { rows: [{ id: 'stored-message' }] };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).connect = async () => ({
    query: async (sql: string) => {
      calls.push(sql);
      if (/SELECT wa_chat_id FROM conversations/.test(sql)) {
        if (++targetSelections === 1) {
          targetSelected();
          await targetGate;
        }
        return { rows: [{ wa_chat_id: null }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });
  try {
    const { BaileysClient } = await loadClientModule();
    const client = new BaileysClient('/tmp/unused-lid-order-test', 'test-key') as any;
    client.logger = { info() {}, warn() {}, error() {} };
    client.rememberMessageForRetry = () => {};
    client.rememberKey = () => {};
    client.contactNameFor = () => undefined;
    client.ensureConversationAvatarIfMissing = async () => {};
    client.ensureParticipantAvatarIfMissing = async () => {};
    client.phoneFromJid = () => undefined;
    const pending = client.ingestMessage({
      key: { remoteJid: PROD_LID_JID, remoteJidAlt: PN_JID, id: 'ordered', fromMe: false },
      message: { conversation: 'hello' },
      messageTimestamp: 1_700_000_000,
    }, { publishEvent: false });
    await selected;
    assert.equal(calls.some(sql => /INSERT INTO (whatsapp_message_payloads|messages)\b/.test(sql)), false);
    await client.ingestMessage({
      key: { remoteJid: PN_JID, remoteJidAlt: PROD_LID_JID, id: 'pn-echo', fromMe: true },
      message: { conversation: 'echo' },
      messageTimestamp: 1_700_000_001,
    }, { publishEvent: false });
    assert.deepEqual(conversationIds, [PROD_LID_JID, PROD_LID_JID], 'overlapping PN echo never creates a PN conversation');
    client.sock = { signalRepository: { lidMapping: { getLIDForPN: async () => PROD_LID_JID } } };
    await client.ingestMessage({
      key: { remoteJid: PN_JID, id: 'mapped-echo', fromMe: true },
      message: { conversation: 'mapped echo' },
      messageTimestamp: 1_700_000_002,
    }, { publishEvent: false });
    assert.deepEqual(conversationIds, [PROD_LID_JID, PROD_LID_JID, PROD_LID_JID], 'Baileys mapping also avoids a PN row');
    releaseTarget();
    await pending;
    const assignment = calls.findIndex(sql => /SET wa_chat_id = \$2/.test(sql));
    const payload = calls.findIndex(sql => /INSERT INTO whatsapp_message_payloads/.test(sql));
    const message = calls.findIndex(sql => /INSERT INTO messages\b/.test(sql));
    assert.ok(assignment >= 0 && payload > assignment && message > payload);
  } finally {
    releaseTarget();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg.Pool.prototype as any).query = originalQuery;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg.Pool.prototype as any).connect = originalConnect;
  }
});

test('setConversationWaChatId is a no-op on empty inputs (never issues a query)', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('professional');
    await w.setConversationWaChatId('', PN_JID);
    await w.setConversationWaChatId(PROD_LID_JID, '');
    assert.equal(calls.length, 0, 'guarded inputs must not hit the DB');
  } finally {
    restore();
  }
});

test('group sender PN never replaces a group conversation JID', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('personal');
    await w.setConversationWaChatId('120363000000000000@g.us', PN_JID);
    await w.setConversationWaChatId(PROD_LID_JID, '120363000000000000@g.us');
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});
