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
// setConversationWaChatId: namespaced, UNIQUE-safe, only backfills the empty col
// ---------------------------------------------------------------------------

test('professional setConversationWaChatId namespaces both the WHERE id and the stored value', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('professional');
    await w.setConversationWaChatId(PROD_LID_JID, PN_JID);
    const u = findUpdate(calls, 'conversations')!;
    assert.equal(u.params[0], `professional:${PROD_LID_JID}`, 'WHERE id is the namespaced LID row');
    assert.equal(
      u.params[1],
      `professional:${PN_JID}`,
      'stored wa_chat_id is namespaced (UNIQUE col shared across accounts — PR #22)'
    );
    // Only backfills: must guard against clobbering an existing non-empty value.
    assert.match(u.sql, /wa_chat_id IS NULL OR wa_chat_id = ''/i);
  } finally {
    restore();
  }
});

test('personal setConversationWaChatId keeps both id and value bare', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('personal');
    await w.setConversationWaChatId(PROD_LID_JID, PN_JID);
    const u = findUpdate(calls, 'conversations')!;
    assert.equal(u.params[0], PROD_LID_JID);
    assert.equal(u.params[1], PN_JID);
  } finally {
    restore();
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
