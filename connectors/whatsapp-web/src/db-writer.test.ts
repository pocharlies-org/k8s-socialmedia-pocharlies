/**
 * Regression tests for the conversation/participant/message id-namespacing bug.
 *
 * Bug (prod 2026-06-11, message 3EB0EABFF068A71576FE7C on the professional
 * account): `ensureConversation`/`ensureParticipant`/`storeMessage` namespaced
 * their ids via accountKey() (-> `professional:<id>`), but
 * `linkParticipantToConversation` and `storeMessageKey` inserted the BARE ids.
 * For a brand-new chat the FK target `conversations.id` therefore did not exist
 * under the bare id -> `conversation_participants_conversation_id_fkey`
 * violation -> the whole ingest aborted and the message was never persisted.
 * The personal account was immune because accountKey() is a no-op there.
 *
 * These tests assert the invariant: for a given conversation, the id bound into
 * conversations.id is byte-for-byte the id bound into conversation_participants
 * and whatsapp_message_keys. They run with no real DB by stubbing pg.Pool#query
 * and capturing the SQL + bound params.
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

/**
 * Stub pg.Pool#query for the duration of one test. db-writer's getPool() is
 * lazy and memoised per module instance, so each isolated module instance
 * (loaded with a distinct CONNECTOR_ACCOUNT) builds its own Pool whose query we
 * intercept here. Returns the capture buffer + a restore fn.
 */
function stubPoolQuery(): { calls: CapturedQuery[]; restore: () => void } {
  const calls: CapturedQuery[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    // Mimic INSERT ... RETURNING id used by storeMessage.
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

/**
 * Bind the db-writer to a specific account. accountKey()/the SQL writers read
 * CONNECTOR_ACCOUNT from process.env at call time, so a single import is enough
 * and the env var fully controls the namespacing per test.
 */
async function loadWriter(account: string): Promise<typeof import('./db-writer.js')> {
  process.env.CONNECTOR_ACCOUNT = account;
  return (await import('./db-writer.ts')) as typeof import('./db-writer.js');
}

const tableOf = (sql: string): string => {
  const m = /insert into (\w+)/i.exec(sql);
  return m ? m[1].toLowerCase() : '';
};
const find = (calls: CapturedQuery[], table: string): CapturedQuery =>
  calls.find(c => tableOf(c.sql) === table)!;

test('professional: new-conversation ingest uses consistent namespaced ids across all FK tables', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('professional');
    const convBare = '34600111222@s.whatsapp.net';
    const partBare = '34600111222';
    const msgBare = '3EB0EABFF068A71576FE7C';

    await w.ensureConversation({ id: convBare, name: 'Cliente', isGroup: false, participantCount: 2 });
    await w.ensureParticipant({ id: partBare, name: 'Cliente', pushName: 'Cliente' });
    await w.linkParticipantToConversation(convBare, partBare);
    await w.storeMessage({
      waMessageId: msgBare,
      conversationId: convBare,
      senderWaId: partBare,
      waTimestamp: new Date(),
      direction: 'INBOUND',
      content: 'BAJA',
      messageType: 'TEXT',
      isForwarded: false,
    });
    await w.storeMessageKey({
      waMessageId: msgBare,
      conversationId: convBare,
      remoteJid: convBare,
      fromMe: false,
      messageTimestampMs: Date.now(),
    });

    const conv = find(calls, 'conversations');
    const link = find(calls, 'conversation_participants');
    const msg = find(calls, 'messages');
    const key = find(calls, 'whatsapp_message_keys');

    // conversations.id is namespaced.
    assert.equal(conv.params[0], 'professional:34600111222@s.whatsapp.net');

    // The bug: conversation_participants.conversation_id MUST equal conversations.id.
    assert.equal(
      link.params[0],
      conv.params[0],
      'conversation_participants.conversation_id must match conversations.id (FK target)'
    );
    // and participant_id must be namespaced too.
    assert.equal(link.params[1], 'professional:34600111222');

    // messages FKs must point at the same namespaced parents.
    assert.equal(msg.params[1], conv.params[0]); // conversation_id
    assert.equal(msg.params[2], link.params[1]); // sender_wa_id

    // whatsapp_message_keys FKs must point at the same namespaced parents.
    assert.equal(key.params[0], 'professional:3EB0EABFF068A71576FE7C'); // wa_message_id -> messages
    assert.equal(key.params[1], conv.params[0]); // conversation_id -> conversations
  } finally {
    restore();
  }
});

test('personal: ids stay bare (no prefix) and remain mutually consistent', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('personal');
    const conv = '34699@s.whatsapp.net';
    const part = '34699';
    await w.ensureConversation({ id: conv, name: 'n', isGroup: false, participantCount: 2 });
    await w.linkParticipantToConversation(conv, part);

    const c = find(calls, 'conversations');
    const l = find(calls, 'conversation_participants');
    assert.equal(c.params[0], conv, 'personal account keeps conversation id bare');
    assert.equal(l.params[0], conv);
    assert.equal(l.params[1], part);
  } finally {
    restore();
  }
});

test('accountKey is idempotent and never double-prefixes', async () => {
  const w = await loadWriter('professional');
  assert.equal(w.accountKey('abc'), 'professional:abc');
  assert.equal(w.accountKey('professional:abc'), 'professional:abc');
  await loadWriter('personal');
  assert.equal(w.accountKey('abc'), 'abc', 'switching account env flips namespacing at call time');
});

test('PN aliases resolve only to one LID in the connector account', async () => {
  const original = pg.Pool.prototype.query;
  const calls: CapturedQuery[] = [];
  let matches: { id: string }[] = [{ id: 'professional:12345@lid' }];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows: matches };
  };
  try {
    const writer = await loadWriter('professional');
    assert.equal(await writer.canonicalConversationId('34600@c.us'), '12345@lid');
    assert.deepEqual(calls[0].params, ['professional', ['professional:34600@c.us', 'professional:34600@s.whatsapp.net']]);
    assert.match(calls[0].sql, /account = \$1/);
    assert.match(calls[0].sql, /LIMIT 2/);
    matches = [];
    assert.equal(await writer.canonicalConversationId('34600@s.whatsapp.net'), '34600@s.whatsapp.net');
    matches = [{ id: 'professional:12345@lid' }, { id: 'professional:67890@lid' }];
    assert.equal(await writer.canonicalConversationId('34600@c.us'), '34600@c.us');
    assert.equal(await writer.canonicalConversationId('12345@lid'), '12345@lid');
    assert.equal(calls.length, 3, 'LID does not need an alias lookup');
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg.Pool.prototype as any).query = original;
  }
});

test('name writers preserve useful contact/group names over JID placeholders', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('professional');
    await w.ensureConversation({
      id: '123456789012345@lid',
      name: '123456789012345@lid',
      isGroup: false,
      participantCount: 2,
    });
    await w.ensureParticipant({
      id: '123456789012345@lid',
      name: 'Perfil',
      pushName: 'Perfil',
    });
    await w.setConversationName('123456789012345@lid', 'Agenda');
    await w.setParticipantName('123456789012345@lid', 'Agenda', 'Perfil');

    const conversation = find(calls, 'conversations');
    const participant = find(calls, 'participants');
    assert.match(conversation.sql, /name = CASE/i);
    assert.match(conversation.sql, /LIKE '%@lid'/i);
    assert.match(participant.sql, /participants\.name = participants\.push_name/i);
    const updates = calls.filter(call => /^\s*UPDATE/i.test(call.sql));
    assert.equal(updates.length, 2);
    assert.match(updates[0].sql, /SET name = CASE/i);
    assert.deepEqual(updates[0].params[0], ['professional:123456789012345@lid']);
    assert.deepEqual(updates[0].params[1], ['123456789012345@lid']);
    assert.equal(updates[0].params[2], 'Agenda');
    assert.deepEqual(updates[1].params[0], ['professional:123456789012345@lid']);
    assert.equal(updates[0].params[3], 'professional');
    assert.equal(updates[0].params[4], true);
    assert.equal(updates[1].params[3], 'professional');
  } finally {
    restore();
  }
});

test('push fallback name writer is explicitly non-authoritative', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('professional');
    await w.setConversationName('123456789012345@lid', 'Perfil', { authoritative: false });
    const update = calls.find(call => /^\s*UPDATE conversations/i.test(call.sql))!;
    assert.equal(update.params[2], 'Perfil');
    assert.equal(update.params[4], false);
    assert.match(update.sql, /WHEN \$5::boolean/i);
    assert.match(update.sql, /ELSE conversations\.name/i);
  } finally {
    restore();
  }
});

test('linkParticipantToConversation surfaces FK failures with full context', async () => {
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function () {
    const err = Object.assign(
      new Error('insert or update on table "conversation_participants" violates foreign key'),
      { code: '23503', constraint: 'conversation_participants_conversation_id_fkey' }
    );
    return Promise.reject(err);
  };
  try {
    const w = await loadWriter('professional');
    await assert.rejects(
      () => w.linkParticipantToConversation('34600@s.whatsapp.net', '34600'),
      (e: Error) => {
        assert.match(e.message, /account=professional/);
        assert.match(e.message, /conversation_id=professional:34600@s\.whatsapp\.net/);
        assert.match(e.message, /pgcode=23503/);
        assert.match(e.message, /constraint=conversation_participants_conversation_id_fkey/);
        return true;
      }
    );
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg.Pool.prototype as any).query = original;
  }
});
