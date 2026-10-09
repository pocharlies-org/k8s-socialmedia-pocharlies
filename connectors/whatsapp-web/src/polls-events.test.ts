/**
 * Polls and events (fase 3 / PR-7) — the client and the HTTP routes: POLL /
 * EVENT rows, inbound votes and responses (a contact, our phone, PN/LID
 * identities, unknown poll), our vote / response (identities, retract,
 * restart-proof, ingest off, table missing), results and the routes (gate,
 * signed body, validation, idempotency).
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test (same harness as message-reactions.test.ts).
 * The DB side (upsert order, retract, PN/LID collapse, merge) is exercised
 * against a real Postgres when migration 013 is validated.
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
import { decryptEventResponse, decryptPollVote } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysClient, BaileysClientOptions, responsesLast } from './baileys-client';
import {
  resetDurableStoreStateForTests,
  serializeDurableValue,
  toDurablePayload,
} from './durable-message-store';
import { resetPollEventStoreStateForTests } from './poll-event-store';
import { resetSendIdempotencyStateForTests } from './send-idempotency';
import { buildPollVoteContent, optionHash, PollEventInputError } from './poll-votes';
import { buildEventResponseContent } from './event-responses';
import { MessageMutationError } from './message-mutations';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

interface QueryCall {
  sql: string;
  params: unknown[];
}
type Rows = Record<string, unknown>[];

function stubPool(route: (sql: string, params: unknown[]) => Rows | Error = () => []): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    const out = route(sql, params);
    return out instanceof Error
      ? Promise.reject(out)
      : Promise.resolve({ rows: out, rowCount: out.length });
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
  resetPollEventStoreStateForTests();
  resetSendIdempotencyStateForTests();
}

const isVoteInsert = (sql: string): boolean => /INSERT INTO whatsapp_poll_votes/i.test(sql);
const isResponseInsert = (sql: string): boolean =>
  /INSERT INTO whatsapp_event_responses/i.test(sql);
const isMessageInsert = (sql: string): boolean => /INSERT INTO messages/i.test(sql);
const isPayloadSelect = (sql: string): boolean =>
  /FROM whatsapp_message_payloads/i.test(sql) && /SELECT/i.test(sql);
const isPayloadInsert = (sql: string): boolean =>
  /INSERT INTO whatsapp_message_payloads/i.test(sql);
const isStoredSelect = (sql: string): boolean =>
  /FROM messages m\s+LEFT JOIN whatsapp_message_keys/i.test(sql);

function missingTable(name: string): Error {
  return Object.assign(new Error(`relation "${name}" does not exist`), { code: '42P01' });
}

const SECRET = new Uint8Array(32).fill(9);
const GROUP = '120363000@g.us';
const ME_PN = '34999@s.whatsapp.net';
const ME_LID = '9999@lid';
const NOW_S = 1_790_000_000;

interface Relayed {
  jid: string;
  message: any;
  messageId: string;
}

function makeClient(
  options: BaileysClientOptions = {},
  extra: { addressingMode?: 'lid' | 'pn'; pnForLid?: Record<string, string> } = {}
): { client: BaileysClient; sent: Array<{ jid: string; content: any; options: any }>; relayed: Relayed[] } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const sent: Array<{ jid: string; content: any; options: any }> = [];
  const relayed: Relayed[] = [];
  let n = 0;
  const sock = {
    user: { id: '34999:3@s.whatsapp.net', lid: '9999:3@lid' },
    sendMessage: async (jid: string, content: any, opts?: any) => {
      sent.push({ jid, content, options: opts });
      n += 1;
      const id = opts?.messageId || `SENT${n}`;
      return {
        key: { remoteJid: jid, id, fromMe: true },
        message: content.poll
          ? {
              messageContextInfo: { messageSecret: SECRET },
              pollCreationMessageV3: {
                name: content.poll.name,
                options: content.poll.values.map((optionName: string) => ({ optionName })),
                selectableOptionsCount: content.poll.selectableCount,
              },
            }
          : { messageContextInfo: { messageSecret: SECRET }, eventMessage: { name: content.event?.name } },
        messageTimestamp: NOW_S,
      };
    },
    relayMessage: async (jid: string, message: any, opts: { messageId: string }) => {
      relayed.push({ jid, message, messageId: opts.messageId });
      return opts.messageId;
    },
    groupMetadata: async (jid: string) => ({
      id: jid,
      subject: 'Grupo',
      participants: [],
      addressingMode: extra.addressingMode || 'lid',
    }),
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid: string) => extra.pnForLid?.[lid] || null,
        getLIDForPN: async () => null,
      },
    },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean; meJid: string };
  internals.sock = sock;
  internals.ready = true;
  internals.meJid = ME_PN;
  return { client, sent, relayed };
}

function priv(client: BaileysClient): any {
  return client as any;
}

/** Someone's poll in a LID-addressed group. */
function pollMessage(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    key: {
      remoteJid: GROUP,
      id: 'POLL1',
      fromMe: false,
      participant: '2222@lid',
      participantAlt: '34600@s.whatsapp.net',
    },
    message: {
      messageContextInfo: { messageSecret: SECRET },
      pollCreationMessageV3: {
        name: '¿Cena?',
        options: [{ optionName: 'Sí' }, { optionName: 'No' }],
        selectableOptionsCount: 1,
      },
    },
    messageTimestamp: NOW_S,
    pushName: 'Ada',
    ...overrides,
  } as WAMessage;
}

function eventMessage(overrides: Partial<WAMessage> = {}, fields: Record<string, unknown> = {}): WAMessage {
  return {
    key: {
      remoteJid: GROUP,
      id: 'EV1',
      fromMe: false,
      participant: '2222@lid',
      participantAlt: '34600@s.whatsapp.net',
    },
    message: {
      messageContextInfo: { messageSecret: SECRET },
      eventMessage: {
        name: 'Partida',
        startTime: 1_791_190_800,
        location: { name: 'Campo' },
        extraGuestsAllowed: false,
        ...fields,
      },
    },
    messageTimestamp: NOW_S,
    ...overrides,
  } as WAMessage;
}

/** A vote as another member sends it. */
function voteMessage(opts: {
  id: string;
  options: string[];
  creator: string;
  voter: string;
  key: Record<string, unknown>;
  ms?: number;
}): WAMessage {
  const content = buildPollVoteContent({
    creationKey: { remoteJid: GROUP, id: 'POLL1', fromMe: false, participant: '2222@lid' },
    secret: SECRET,
    creator: opts.creator,
    voter: opts.voter,
    options: opts.options,
    senderTimestampMs: opts.ms ?? NOW_S * 1000 + 500,
  });
  return {
    key: { remoteJid: GROUP, id: opts.id, fromMe: false, ...opts.key },
    message: { messageContextInfo: { messageSecret: new Uint8Array(32).fill(1) }, ...content },
    messageTimestamp: NOW_S + 1,
  } as WAMessage;
}

/** A payload row as getRawWAMessage selects it. */
function payloadRow(msg: WAMessage): Rows {
  return [
    {
      message_key: serializeDurableValue(msg.key),
      message_payload: serializeDurableValue(toDurablePayload(msg.message)),
      wa_timestamp: new Date(NOW_S * 1000),
      push_name: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// POLL / EVENT rows
// ---------------------------------------------------------------------------

test('a poll is ingested as a POLL row (question, metadata.poll) and its payload kept at any age', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient();
    const old = pollMessage({ messageTimestamp: NOW_S - 400 * 24 * 3600 });
    await priv(client).ingestMessage(old, { source: 'baileys_history_sync', publishEvent: false });
    const insert = calls.find(c => isMessageInsert(c.sql))!;
    assert.equal(insert.params[0], 'professional:POLL1');
    assert.equal(insert.params[5], '¿Cena?');
    assert.equal(insert.params[6], 'POLL');
    const metadata = JSON.parse(String(insert.params[10]));
    assert.deepEqual(metadata.poll, { question: '¿Cena?', options: ['Sí', 'No'], selectableCount: 1 });
    assert.doesNotMatch(String(insert.params[10]), /messageSecret/, 'the secret never goes to messages');
    assert.equal(
      calls.filter(c => isPayloadInsert(c.sql)).length,
      1,
      'a 400-day-old poll payload is still kept (its secret decrypts the votes)'
    );
  } finally {
    restore();
  }
});

test('an event is ingested as an EVENT row with metadata.event', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient();
    await priv(client).ingestMessage(eventMessage(), { source: 'live', publishEvent: false });
    const insert = calls.find(c => isMessageInsert(c.sql))!;
    assert.equal(insert.params[6], 'EVENT');
    assert.equal(insert.params[5], 'Partida');
    const metadata = JSON.parse(String(insert.params[10]));
    assert.equal(metadata.event.startTime, 1_791_190_800_000);
    assert.deepEqual(metadata.event.location, { name: 'Campo' });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Inbound votes / responses
// ---------------------------------------------------------------------------

test('an inbound vote is decrypted into whatsapp_poll_votes; no messages row', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient();
    await priv(client).ingestMessage(pollMessage(), { source: 'live', publishEvent: false });
    calls.length = 0;
    const vote = voteMessage({
      id: 'VOTE1',
      options: ['No'],
      creator: '2222@lid',
      voter: '3333@lid',
      key: { participant: '3333@lid' },
    });
    const result = await priv(client).ingestMessage(vote, { source: 'live', publishEvent: false });
    assert.deepEqual(result, { inserted: false });
    assert.equal(calls.filter(c => isMessageInsert(c.sql)).length, 0, 'a vote is not a chat row');
    const [row] = calls.filter(c => isVoteInsert(c.sql));
    assert.deepEqual(row.params, [
      'professional',
      'professional:POLL1',
      'professional:3333@lid',
      'professional:120363000@g.us',
      'professional:VOTE1',
      ['No'],
      [optionHash('No')],
      false,
      false,
      new Date(NOW_S * 1000 + 500),
    ]);
    assert.match(row.sql, /EXCLUDED\.voted_at >= whatsapp_poll_votes\.voted_at/, 'older never wins');
    assert.equal(calls.filter(c => isPayloadInsert(c.sql)).length, 1, 'the raw vote is kept');
  } finally {
    restore();
  }
});

test('PN-signed votes of a LID participant decrypt (alt jid or Baileys mapping); a change and a retract', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient({}, { pnForLid: { '4444@lid': '34622@s.whatsapp.net' } });
    await priv(client).ingestMessage(pollMessage(), { source: 'live', publishEvent: false });
    // Phone jids in the crypto, LID in the key + participantAlt.
    await priv(client).ingestMessage(
      voteMessage({
        id: 'V1',
        options: ['Sí'],
        creator: '34600@s.whatsapp.net',
        voter: '34611@s.whatsapp.net',
        key: { participant: '3333@lid', participantAlt: '34611@s.whatsapp.net' },
      }),
      { source: 'live', publishEvent: false }
    );
    // No alternate on the key: Baileys' LID mapping knows the PN.
    await priv(client).ingestMessage(
      voteMessage({
        id: 'V2',
        options: ['No'],
        creator: '34600@s.whatsapp.net',
        voter: '34622@s.whatsapp.net',
        key: { participant: '4444@lid' },
      }),
      { source: 'live', publishEvent: false }
    );
    // Retract (empty selection) of the first voter.
    await priv(client).ingestMessage(
      voteMessage({
        id: 'V3',
        options: [],
        creator: '2222@lid',
        voter: '3333@lid',
        key: { participant: '3333@lid' },
        ms: NOW_S * 1000 + 9000,
      }),
      { source: 'live', publishEvent: false }
    );
    const rows = calls.filter(c => isVoteInsert(c.sql));
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map(r => [r.params[2], r.params[5], r.params[7]]),
      [
        ['3333@lid', ['Sí'], false],
        ['4444@lid', ['No'], false],
        ['3333@lid', [], true],
      ],
      'the row is filed under the sender id messages use; [] = retracted'
    );
  } finally {
    restore();
  }
});

test('a LID voter whose key also carries the phone number: one row under the LID, the later vote replaces it', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient();
    await priv(client).ingestMessage(pollMessage(), { source: 'live', publishEvent: false });
    calls.length = 0;
    // Fixture of the fork's poll-votes.fork.test.ts ('captured group votes use the encrypted LID even when a
    // PN alias is present', PR #74): a voter signing as a LID, its number on the key.
    const voter = { participant: '123456789@lid', participantAlt: '346000000001@s.whatsapp.net' };
    for (const [id, option, ms] of [
      ['VOTE_A', 'Sí', 1727000001000],
      ['VOTE_B', 'No', 1727000002000],
    ] as const) {
      await priv(client).ingestMessage(
        voteMessage({ id, options: [option], creator: '2222@lid', voter: voter.participant, key: voter, ms }),
        { source: 'live', publishEvent: false }
      );
    }
    const rows = calls.filter(c => isVoteInsert(c.sql));
    assert.deepEqual(
      rows.map(r => [r.params[2], r.params[5], r.params[9]]),
      [
        ['professional:123456789@lid', ['Sí'], new Date(1727000001000)],
        ['professional:123456789@lid', ['No'], new Date(1727000002000)],
      ],
      'both votes are filed under the LID, never under the phone alias: one voter, the newer vote'
    );
    assert.match(rows[1].sql, /ON CONFLICT \(account, poll_wa_message_id, voter_jid\)/);
    assert.match(rows[1].sql, /EXCLUDED\.voted_at >= whatsapp_poll_votes\.voted_at/);
  } finally {
    restore();
  }
});

test('a vote from our phone is ours; an unknown poll or a bad ciphertext is skipped, never a crash', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  const logged: string[] = [];
  try {
    const { client } = makeClient();
    priv(client).logger = {
      info: (m: string) => logged.push(m),
      warn: (m: string) => logged.push(m),
      error: () => {},
      debug: () => {},
    };
    await priv(client).ingestMessage(pollMessage(), { source: 'live', publishEvent: false });
    await priv(client).ingestMessage(
      voteMessage({
        id: 'MINE',
        options: ['Sí'],
        creator: '2222@lid',
        voter: ME_LID,
        key: { fromMe: true, participant: ME_LID },
      }),
      { source: 'live', publishEvent: false }
    );
    const mine = calls.find(c => isVoteInsert(c.sql))!;
    assert.equal(mine.params[2], '34999@c.us', 'our own jid, as for reactions');
    assert.equal(mine.params[8], true);

    calls.length = 0;
    const unknown = voteMessage({ id: 'X1', options: ['Sí'], creator: 'a@lid', voter: 'b@lid', key: {} });
    (unknown.message as any).pollUpdateMessage.pollCreationMessageKey.id = 'NOPE';
    await priv(client).ingestMessage(unknown, { source: 'live', publishEvent: false });
    const garbled = voteMessage({
      id: 'X2',
      options: ['Sí'],
      creator: 'z@lid',
      voter: 'y@lid',
      key: { participant: '3333@lid' },
    });
    await priv(client).ingestMessage(garbled, { source: 'live', publishEvent: false });
    assert.equal(calls.filter(c => isVoteInsert(c.sql) || isMessageInsert(c.sql)).length, 0);
    assert.ok(logged.some(m => /X1 for NOPE skipped: poll unknown/.test(m)));
    assert.ok(logged.some(m => /X2 for POLL1 could not be decrypted/.test(m)));
  } finally {
    restore();
  }
});

test('history batches put votes after polls', () => {
  const vote = voteMessage({ id: 'V', options: [], creator: 'a@lid', voter: 'b@lid', key: {} });
  const poll = pollMessage();
  assert.deepEqual(
    responsesLast([vote, poll]).map(m => m.key.id),
    ['POLL1', 'V']
  );
});

test('an inbound event response is decrypted into whatsapp_event_responses', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient();
    // Our own event in a 1:1 chat.
    const ours = eventMessage({ key: { remoteJid: '34600@s.whatsapp.net', id: 'EV2', fromMe: true } });
    await priv(client).ingestMessage(ours, { source: 'live', publishEvent: false });
    const response = buildEventResponseContent({
      eventKey: { remoteJid: ME_PN, id: 'EV2', fromMe: false },
      secret: SECRET,
      creator: ME_PN,
      responder: '34600@s.whatsapp.net',
      response: 'going',
      extraGuestCount: 0,
      timestampMs: NOW_S * 1000 + 42,
    });
    await priv(client).ingestMessage(
      {
        key: { remoteJid: '34600@s.whatsapp.net', id: 'RSVP1', fromMe: false },
        message: response,
        messageTimestamp: NOW_S + 5,
      } as WAMessage,
      { source: 'live', publishEvent: false }
    );
    const [row] = calls.filter(c => isResponseInsert(c.sql));
    assert.deepEqual(row.params, [
      'personal',
      'EV2',
      '34600@c.us',
      '34600@c.us',
      'RSVP1',
      'going',
      0,
      false,
      new Date(NOW_S * 1000 + 42),
    ]);
    assert.equal(calls.filter(c => isMessageInsert(c.sql)).length, 1, 'only the EVENT row');
  } finally {
    restore();
  }
});

test('with ingest off (pairing pool) votes and responses never touch the DB', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client, relayed } = makeClient({ ingest: false });
    const poll = pollMessage();
    priv(client).rememberKey('POLL1', poll.key, GROUP);
    priv(client).rememberMessageForRetry(poll.key, poll.message);
    await priv(client).ingestPollOrEventResponse(
      voteMessage({ id: 'V', options: ['No'], creator: '2222@lid', voter: '3333@lid', key: { participant: '3333@lid' } }),
      { source: 'live' }
    );
    const result = await client.sendPollVote(GROUP, 'POLL1', ['Sí']);
    assert.equal(relayed.length, 1, 'it still votes from memory');
    assert.equal(result.persisted, false);
    assert.equal(calls.length, 0, 'the pairing pool never touches the DB');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Our vote / response
// ---------------------------------------------------------------------------

test('our vote after a restart: poll from its payload, whatsmeow identities, recorded as ours', async () => {
  useAccount('professional');
  const poll = pollMessage();
  const { calls, restore } = stubPool(sql => (isPayloadSelect(sql) ? payloadRow(poll) : []));
  try {
    const { client, relayed } = makeClient({}, { addressingMode: 'lid' });
    const result = await client.sendPollVote('professional:120363000@g.us', 'professional:POLL1', ['No'], {
      actor: 'dani',
    });
    assert.equal(relayed.length, 1);
    const [{ jid, message, messageId }] = relayed;
    assert.equal(jid, GROUP);
    const update = message.pollUpdateMessage;
    assert.equal(update.pollCreationMessageKey.id, 'POLL1');
    assert.equal(update.pollCreationMessageKey.participant, '2222@lid');
    // LID group, someone else's poll: creator as addressed, we vote as our LID.
    const decrypted = decryptPollVote(
      { encPayload: update.vote.encPayload, encIv: update.vote.encIv },
      { pollCreatorJid: '2222@lid', pollMsgId: 'POLL1', pollEncKey: SECRET, voterJid: ME_LID }
    );
    assert.deepEqual(
      (decrypted.selectedOptions || []).map(o => Buffer.from(o).toString('hex')),
      [optionHash('No')]
    );
    const insert = calls.find(c => isVoteInsert(c.sql))!;
    assert.deepEqual(insert.params.slice(0, 9), [
      'professional',
      'professional:POLL1',
      'professional:34999@c.us',
      'professional:120363000@g.us',
      `professional:${messageId}`,
      ['No'],
      [optionHash('No')],
      false,
      true,
    ]);
    assert.deepEqual(
      { ...result, votedAt: undefined },
      {
        messageId,
        pollMessageId: 'POLL1',
        conversationId: GROUP,
        options: ['No'],
        retracted: false,
        votedAt: undefined,
        persisted: true,
      }
    );
    assert.equal(calls.filter(c => isPayloadInsert(c.sql)).length, 1, 'our vote is kept for retries');
  } finally {
    restore();
  }
});

test('retract ([]), our own poll in a phone chat, invalid options never reach WhatsApp', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client, relayed } = makeClient();
    const ours = pollMessage({ key: { remoteJid: '34600@s.whatsapp.net', id: 'MYPOLL', fromMe: true } });
    priv(client).rememberKey('MYPOLL', ours.key, '34600@s.whatsapp.net');
    priv(client).rememberMessageForRetry(ours.key, ours.message);
    const result = await client.sendPollVote('34600@c.us', 'MYPOLL', []);
    assert.equal(result.retracted, true);
    const update = relayed[0].message.pollUpdateMessage;
    const decrypted = decryptPollVote(
      { encPayload: update.vote.encPayload, encIv: update.vote.encIv },
      { pollCreatorJid: ME_PN, pollMsgId: 'MYPOLL', pollEncKey: SECRET, voterJid: ME_PN }
    );
    assert.deepEqual(decrypted.selectedOptions, [], 'phone chat, our poll: our PN on both sides');
    assert.equal(calls.find(c => isVoteInsert(c.sql))!.params[7], true, 'recorded as retracted');

    await assert.rejects(client.sendPollVote('34600@c.us', 'MYPOLL', ['Sí', 'No']), (e: unknown) => {
      assert.ok(e instanceof PollEventInputError);
      assert.match(e.message, /at most 1/);
      return true;
    });
    await assert.rejects(client.sendPollVote('34600@c.us', 'MYPOLL', ['Tal vez']), PollEventInputError);
    assert.equal(relayed.length, 1);
  } finally {
    restore();
  }
});

test('vote refusals: unknown message 404, not a poll 422, poll without secret 422', async () => {
  useAccount('personal');
  let stored: Rows = [];
  const { restore } = stubPool(sql => (isStoredSelect(sql) ? stored : []));
  try {
    const { client, relayed } = makeClient();
    await assert.rejects(client.sendPollVote(GROUP, 'GONE', ['Sí']), (e: any) => e.status === 404);
    const text = { key: { remoteJid: GROUP, id: 'TXT', participant: '2222@lid' }, message: { conversation: 'hola' } };
    priv(client).rememberKey('TXT', text.key, GROUP);
    priv(client).rememberMessageForRetry(text.key, text.message);
    await assert.rejects(client.sendPollVote(GROUP, 'TXT', ['Sí']), (e: unknown) => {
      assert.ok(e instanceof MessageMutationError);
      assert.equal(e.failureClass, 'not_a_poll');
      assert.equal(e.status, 422);
      return true;
    });
    // An old poll row (before the durable payloads): no content, no secret.
    stored = [
      {
        wa_message_id: 'OLD',
        conversation_id: GROUP,
        sender_wa_id: '2222@lid',
        direction: 'INBOUND',
        message_type: 'POLLCREATIONMESSAGEV3',
        content: null,
        is_deleted: false,
        deleted_for_me: false,
        wa_timestamp: new Date(1_700_000_000_000),
        remote_jid: GROUP,
        from_me: false,
        participant_jid: '2222@lid',
        message_timestamp_ms: '1700000000000',
      },
    ];
    await assert.rejects(client.sendPollVote(GROUP, 'OLD', ['Sí']), (e: any) => {
      assert.equal(e.failureClass, 'poll_secret_unavailable');
      return true;
    });
    const noSecret = pollMessage({ key: { remoteJid: GROUP, id: 'NOSEC', participant: '2222@lid' } });
    delete (noSecret.message as any).messageContextInfo;
    priv(client).rememberKey('NOSEC', noSecret.key, GROUP);
    priv(client).rememberMessageForRetry(noSecret.key, noSecret.message);
    await assert.rejects(client.sendPollVote(GROUP, 'NOSEC', ['Sí']), (e: any) => {
      assert.equal(e.failureClass, 'poll_secret_unavailable');
      return true;
    });
    assert.equal(relayed.length, 0);
  } finally {
    restore();
  }
});

test('with the votes table missing the vote still goes out; logged once, re-probed later', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(sql => (isVoteInsert(sql) ? missingTable('whatsapp_poll_votes') : []));
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (msg: string) => void warned.push(String(msg));
  try {
    const { client, relayed } = makeClient();
    const poll = pollMessage();
    priv(client).rememberKey('POLL1', poll.key, GROUP);
    priv(client).rememberMessageForRetry(poll.key, poll.message);
    const first = await client.sendPollVote(GROUP, 'POLL1', ['Sí']);
    const second = await client.sendPollVote(GROUP, 'POLL1', ['No']);
    assert.equal(relayed.length, 2);
    assert.equal(first.persisted, false);
    assert.equal(second.persisted, false);
    assert.equal(calls.filter(c => isVoteInsert(c.sql)).length, 1, 'known missing: skipped');
    assert.equal(warned.filter(w => /migration 013/.test(w)).length, 1);
  } finally {
    console.warn = warn;
    restore();
  }
});

test('our event response: phone identities (from the key alternate), cancelled / guests refused', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client, relayed } = makeClient();
    const event = eventMessage();
    priv(client).rememberKey('EV1', event.key, GROUP);
    priv(client).rememberMessageForRetry(event.key, event.message);
    const result = await client.respondToEvent(GROUP, 'EV1', { response: 'maybe', extraGuestCount: 0 });
    const enc = relayed[0].message.encEventResponseMessage;
    const decoded = decryptEventResponse(
      { encPayload: enc.encPayload, encIv: enc.encIv },
      {
        eventCreatorJid: '34600@s.whatsapp.net',
        eventMsgId: 'EV1',
        eventEncKey: SECRET,
        responderJid: ME_PN,
      }
    );
    assert.equal(decoded.response, 3);
    assert.equal(result.response, 'maybe');
    const insert = calls.find(c => isResponseInsert(c.sql))!;
    assert.deepEqual(insert.params.slice(0, 8), [
      'personal',
      'EV1',
      '34999@c.us',
      '120363000@g.us',
      result.messageId,
      'maybe',
      0,
      true,
    ]);

    await assert.rejects(
      client.respondToEvent(GROUP, 'EV1', { response: 'going', extraGuestCount: 2 }),
      PollEventInputError
    );
    const cancelled = eventMessage({ key: { remoteJid: GROUP, id: 'EVX', participant: '2222@lid' } }, { isCanceled: true });
    priv(client).rememberKey('EVX', cancelled.key, GROUP);
    priv(client).rememberMessageForRetry(cancelled.key, cancelled.message);
    await assert.rejects(client.respondToEvent(GROUP, 'EVX', { response: 'going', extraGuestCount: 0 }), (e: any) => {
      assert.equal(e.failureClass, 'event_cancelled');
      return true;
    });
    // A LID creator without any phone mapping cannot be signed for.
    const lidOnly = eventMessage({ key: { remoteJid: GROUP, id: 'EVL', participant: '7777@lid' } });
    priv(client).rememberKey('EVL', lidOnly.key, GROUP);
    priv(client).rememberMessageForRetry(lidOnly.key, lidOnly.message);
    await assert.rejects(client.respondToEvent(GROUP, 'EVL', { response: 'going', extraGuestCount: 0 }), (e: any) => {
      assert.equal(e.failureClass, 'identity_unavailable');
      return true;
    });
    assert.equal(relayed.length, 1);
  } finally {
    restore();
  }
});

/**
 * The socket has not told us who we are yet: only meJid, and it is a LID. The two tests below adapt the
 * fork's event-client.test.ts ('RSVP resolves LID identities to phone numbers before encrypting the response'
 * and 'unresolvable own or creator identity raises a typed 409 before the send token is claimed', PR #74)
 * to respondToEvent and to the trunk's 422 identity_unavailable.
 */
function onlyOurLid(client: BaileysClient): void {
  priv(client).sock.user = undefined;
  priv(client).meJid = '10000:1@lid';
}

test('our event response when we are only known as a LID: signed with the phone number Baileys maps it to', async () => {
  useAccount('personal');
  const { restore } = stubPool();
  try {
    const { client, relayed } = makeClient({}, { pnForLid: { '10000@lid': '10000@s.whatsapp.net' } });
    onlyOurLid(client);
    const event = eventMessage();
    priv(client).rememberKey('EV1', event.key, GROUP);
    priv(client).rememberMessageForRetry(event.key, event.message);
    await client.respondToEvent(GROUP, 'EV1', { response: 'going', extraGuestCount: 0 });
    const enc = relayed[0].message.encEventResponseMessage;
    const decoded = decryptEventResponse(
      { encPayload: enc.encPayload, encIv: enc.encIv },
      {
        eventCreatorJid: '34600@s.whatsapp.net',
        eventMsgId: 'EV1',
        eventEncKey: SECRET,
        responderJid: '10000@s.whatsapp.net',
      }
    );
    assert.equal(decoded.response, 1);
  } finally {
    restore();
  }
});

test('our event response with no phone number of our own: refused before the claim and before WhatsApp', async () => {
  useAccount('personal');
  const { restore } = stubPool();
  try {
    const { client, relayed } = makeClient();
    onlyOurLid(client);
    const event = eventMessage();
    priv(client).rememberKey('EV1', event.key, GROUP);
    priv(client).rememberMessageForRetry(event.key, event.message);
    let claimed = false;
    await assert.rejects(
      client.respondToEvent(
        GROUP,
        'EV1',
        { response: 'going', extraGuestCount: 0 },
        {
          beforeSend: async () => {
            claimed = true;
          },
        }
      ),
      (e: any) => e.status === 422 && e.failureClass === 'identity_unavailable'
    );
    assert.equal(claimed, false, 'an Idempotency-Key attempt is not spent on a response nobody can read');
    assert.equal(relayed.length, 0);
  } finally {
    restore();
  }
});

test('sending a poll / an event: canonical chat, payload kept, only chat jids', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool((sql, params) =>
    /WITH RECURSIVE/.test(sql) && (params[1] as string[]).includes('34600@c.us')
      ? [{ id: 'professional:1111@lid', external_id: '1111@lid' }]
      : []
  );
  try {
    const { client, sent } = makeClient();
    const poll = await client.sendPoll('professional:34600@c.us', {
      name: '¿Cena?',
      options: ['Sí', 'No'],
      selectableCount: 1,
    });
    assert.equal(sent[0].jid, '1111@lid', 'a merged PN twin sends to its canonical @lid');
    assert.deepEqual(sent[0].content, { poll: { name: '¿Cena?', values: ['Sí', 'No'], selectableCount: 1 } });
    assert.equal(poll.conversationId, '1111@lid');
    assert.equal(calls.filter(c => isPayloadInsert(c.sql)).length, 1, 'with its secret, for votes');
    const event = await client.sendEvent(GROUP, {
      name: 'Partida',
      startTime: new Date('2026-10-04T09:00:00Z'),
    });
    assert.equal(sent[1].jid, GROUP);
    assert.equal(sent[1].content.event.startDate.toISOString(), '2026-10-04T09:00:00.000Z');
    assert.ok(event.messageId);
    for (const bad of ['status@broadcast', '1203@newsletter', 'leila:34600@c.us', '']) {
      await assert.rejects(
        client.sendPoll(bad, { name: 'q', options: ['a', 'b'], selectableCount: 0 }),
        (e: any) => e.failureClass === 'invalid_request'
      );
    }
    assert.equal(sent.length, 2);
  } finally {
    restore();
  }
});

test('results after a restart: definition from the payload, votes from the table', async () => {
  useAccount('professional');
  const poll = pollMessage();
  const { restore } = stubPool(sql => {
    if (isPayloadSelect(sql)) return payloadRow(poll);
    if (/metadata->'poll'/.test(sql)) return [{ conversation_id: 'professional:120363000@g.us', poll: null, event: null }];
    if (/FROM whatsapp_poll_votes_current/.test(sql)) {
      return [
        { voter_jid: 'professional:3333@lid', selected_options: ['No'], selected_hashes: [], from_me: false, voted_at: new Date(1) },
        { voter_jid: 'professional:34999@c.us', selected_options: ['Sí'], selected_hashes: [], from_me: true, voted_at: new Date(2) },
      ];
    }
    return [];
  });
  try {
    const { client } = makeClient();
    const results = await client.getPollResults('professional:120363000@g.us', 'professional:POLL1');
    assert.deepEqual(results, {
      messageId: 'POLL1',
      conversationId: '120363000@g.us',
      question: '¿Cena?',
      selectableCount: 1,
      options: [
        { name: 'Sí', votes: 1, voters: [{ jid: '34999@c.us', fromMe: true }] },
        { name: 'No', votes: 1, voters: [{ jid: '3333@lid', fromMe: false }] },
      ],
      totalVoters: 2,
      myVote: ['Sí'],
      persisted: true,
    });
  } finally {
    restore();
  }
});

test('results from the row metadata alone; 404 unknown, 422 not a poll, table missing = persisted false', async () => {
  useAccount('personal');
  let meta: Rows = [];
  const { restore } = stubPool(sql => {
    if (/metadata->'poll'/.test(sql)) return meta;
    if (/FROM whatsapp_poll_votes_current/.test(sql)) return missingTable('whatsapp_poll_votes');
    if (/FROM whatsapp_event_responses_current/.test(sql)) {
      return [{ responder_jid: '34600@c.us', response: 'going', extra_guest_count: 1, from_me: false, responded_at: null }];
    }
    return [];
  });
  try {
    const { client } = makeClient();
    await assert.rejects(client.getPollResults(GROUP, 'NONE'), (e: any) => e.status === 404);
    meta = [{ conversation_id: GROUP, poll: null, event: null }];
    await assert.rejects(client.getPollResults(GROUP, 'TXT'), (e: any) => e.failureClass === 'not_a_poll');
    meta = [
      {
        conversation_id: GROUP,
        poll: { question: 'Q', options: ['a', 'b'], selectableCount: 0 },
        event: { name: 'Partida', startTime: 1, endTime: null, location: null, isCanceled: false },
      },
    ];
    const poll = await client.getPollResults(GROUP, 'P');
    assert.equal(poll.persisted, false);
    assert.deepEqual(poll.options.map(o => o.votes), [0, 0]);
    const event = await client.getEventResults(GROUP, 'E');
    assert.equal(event.name, 'Partida');
    assert.deepEqual(event.counts, { going: 1, maybe: 0, not_going: 0 });
    assert.equal(event.extraGuests, 1);
    assert.equal(event.persisted, true);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Call = (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;

async function withRouter(
  client: Partial<BaileysClient>,
  env: Record<string, string | undefined>,
  run: (call: Call, port: number) => Promise<void>
): Promise<void> {
  const secret = 'test-secret';
  const app = express();
  app.use(express.json());
  const qr = { getCurrentQR: () => null, clearQR: () => {} };
  app.use('/api/v1', createRouter(client as BaileysClient, qr as never, secret));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const call: Call = (path, body, headers = {}) => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(ts),
        'x-connector-signature': generateHMACSignature(body ?? {}, ts, secret),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  };
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await run(call, port);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
}

function recordingClient(): { client: Partial<BaileysClient>; seen: string[] } {
  const seen: string[] = [];
  const client = {
    isConnected: () => true,
    getCachedState: () => 'CONNECTED',
    isIngestEnabled: () => false,
    sendPoll: async (chatId: string, poll: unknown, options: any) => {
      seen.push(`poll:${chatId}:${JSON.stringify(poll)}:${options?.actor || ''}`);
      await options?.beforeSend?.();
      return { messageId: options?.messageId || 'P1', conversationId: chatId, sentAt: 't' };
    },
    sendPollVote: async (chatId: string, id: string, options: unknown) => {
      seen.push(`vote:${chatId}:${id}:${JSON.stringify(options)}`);
      return { messageId: 'V1', pollMessageId: id, conversationId: chatId, options, retracted: false, votedAt: 't', persisted: true };
    },
    getPollResults: async (chatId: string, id: string) => {
      seen.push(`results:${chatId}:${id}`);
      return { messageId: id, conversationId: chatId };
    },
    sendEvent: async (chatId: string, event: any) => {
      seen.push(`event:${chatId}:${event.name}:${event.startTime.toISOString()}`);
      return { messageId: 'E1', conversationId: chatId, sentAt: 't' };
    },
    respondToEvent: async (chatId: string, id: string, answer: unknown) => {
      seen.push(`respond:${chatId}:${id}:${JSON.stringify(answer)}`);
      return { messageId: 'R1', eventMessageId: id };
    },
    getEventResults: async (chatId: string, id: string) => {
      seen.push(`eresults:${chatId}:${id}`);
      return { messageId: id };
    },
  };
  return { client: client as unknown as Partial<BaileysClient>, seen };
}

const ON = { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined };
const VALID: Array<[string, Record<string, unknown>]> = [
  ['/messages/poll', { conversationId: GROUP, name: '¿Cena?', options: ['Sí', 'No'], actor: 'dani' }],
  ['/messages/poll/vote', { conversationId: GROUP, messageId: 'POLL1', options: ['Sí'] }],
  ['/messages/event', { conversationId: GROUP, name: 'Partida', startTime: '2026-10-04T09:00:00Z' }],
  ['/messages/event/respond', { conversationId: GROUP, messageId: 'EV1', response: 'going' }],
];

test('HTTP: the four sends are gated (403) after validation; results are not', async () => {
  const { client, seen } = recordingClient();
  for (const env of [
    { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' },
  ]) {
    await withRouter(client, env, async call => {
      for (const [path, body] of VALID) {
        const res = await call(path, body);
        assert.equal(res.status, 403, path);
        assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'disabled_sending');
      }
      // Invalid is 400 before the gate.
      const bad = await call('/messages/poll', { conversationId: GROUP, name: 'q', options: ['solo'] });
      assert.equal(bad.status, 400);
      assert.equal((await call('/messages/poll/results', { conversationId: GROUP, messageId: 'P' })).status, 200);
      assert.equal((await call('/messages/event/results', { conversationId: GROUP, messageId: 'E' })).status, 200);
    });
  }
  assert.deepEqual(seen, [
    `results:${GROUP}:P`,
    `eresults:${GROUP}:E`,
    `results:${GROUP}:P`,
    `eresults:${GROUP}:E`,
  ]);
});

test('HTTP: 200 shapes; ids in the signed body; a tampered or unsigned body is 401', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async (call, port) => {
    const poll = await call(VALID[0][0], VALID[0][1]);
    assert.equal(poll.status, 200);
    assert.deepEqual(await poll.json(), { sent: true, messageId: 'P1', conversationId: GROUP, sentAt: 't' });
    assert.equal((await call(VALID[1][0], VALID[1][1])).status, 200);
    const retract = await call('/messages/poll/vote', { conversationId: GROUP, messageId: 'POLL1', options: [] });
    assert.equal(((await retract.json()) as { voted: boolean }).voted, true);
    assert.equal((await call(VALID[2][0], VALID[2][1])).status, 200);
    assert.equal((await call(VALID[3][0], VALID[3][1])).status, 200);
    const results = await call('/messages/poll/results', { conversationId: GROUP, messageId: 'POLL1' });
    assert.deepEqual(await results.json(), { poll: { messageId: 'POLL1', conversationId: GROUP } });

    const ts = Math.floor(Date.now() / 1000);
    const signed = generateHMACSignature(VALID[1][1], ts, 'test-secret');
    const tampered = await fetch(`http://127.0.0.1:${port}/api/v1/messages/poll/vote`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(ts),
        'x-connector-signature': signed,
      },
      body: JSON.stringify({ ...VALID[1][1], messageId: 'OTHER' }),
    });
    assert.equal(tampered.status, 401);
    const unsigned = await fetch(`http://127.0.0.1:${port}/api/v1/messages/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID[0][1]),
    });
    assert.equal(unsigned.status, 401);
  });
  assert.deepEqual(seen, [
    `poll:${GROUP}:{"name":"¿Cena?","options":["Sí","No"],"selectableCount":0}:dani`,
    `vote:${GROUP}:POLL1:["Sí"]`,
    `vote:${GROUP}:POLL1:[]`,
    `event:${GROUP}:Partida:2026-10-04T09:00:00.000Z`,
    `respond:${GROUP}:EV1:{"response":"going","extraGuestCount":0}`,
    `results:${GROUP}:POLL1`,
  ]);
});

test('HTTP: 400 invalid requests (option counts, shapes), 503 disconnected, client errors mapped', async () => {
  const { client, seen } = recordingClient();
  let connected = true;
  Object.assign(client, {
    isConnected: () => connected,
    sendPollVote: async () => {
      throw new MessageMutationError('no secret', 422, 'poll_secret_unavailable');
    },
    respondToEvent: async () => {
      throw new PollEventInputError('This event does not allow extra guests', { field: 'extraGuestCount' });
    },
  });
  await withRouter(client, ON, async call => {
    const invalid: Array<[string, unknown]> = [
      ['/messages/poll', { name: 'q', options: ['a', 'b'] }],
      ['/messages/poll', { conversationId: GROUP, name: 'q', options: ['a'] }],
      ['/messages/poll', { conversationId: GROUP, name: 'q', options: Array.from({ length: 13 }, (_, i) => `${i}`) }],
      ['/messages/poll', { conversationId: GROUP, name: 'q', options: ['a', 'b'], selectableCount: 3 }],
      ['/messages/poll/vote', { conversationId: GROUP, messageId: 'P', options: 'Sí' }],
      ['/messages/poll/vote', { conversationId: GROUP, options: ['Sí'] }],
      ['/messages/poll/results', { conversationId: GROUP }],
      ['/messages/event', { conversationId: GROUP, name: 'x' }],
      ['/messages/event/respond', { conversationId: GROUP, messageId: 'E', response: 'yes' }],
      ['/messages/event/results', { messageId: 'E' }],
    ];
    for (const [path, body] of invalid) {
      const res = await call(path, body);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'invalid_request');
    }
    const refused = await call(VALID[1][0], VALID[1][1]);
    assert.equal(refused.status, 422);
    assert.deepEqual(await refused.json(), { error: 'no secret', failureClass: 'poll_secret_unavailable' });
    const guests = await call(VALID[3][0], VALID[3][1]);
    assert.equal(guests.status, 400);
    assert.equal(((await guests.json()) as { details: { field: string } }).details.field, 'extraGuestCount');
    connected = false;
    const offline = await call(VALID[0][0], VALID[0][1]);
    assert.equal(offline.status, 503);
    assert.equal(((await offline.json()) as { failureClass: string }).failureClass, 'disconnected');
  });
  assert.deepEqual(seen, []);
});

/** whatsapp_send_attempts as the connector drives it (migration 010): prepared → pending → sent. */
function stubSendAttempts(): ReturnType<typeof stubPool> {
  const attempts = new Map<string, { request_hash: string; message_id: string; status: string }>();
  return stubPool((sql, params) => {
    const key = `${params[0]}:${params[1]}`;
    if (/INSERT INTO whatsapp_send_attempts/.test(sql)) {
      if (attempts.has(key)) return [];
      attempts.set(key, { request_hash: String(params[2]), message_id: String(params[3]), status: 'prepared' });
      return [{ message_id: params[3] }];
    }
    const row = attempts.get(key);
    if (/SELECT request_hash/.test(sql)) return row ? [{ ...row, updated_at: new Date(5) }] : [];
    if (/SET status = 'pending'/.test(sql) && row?.status === 'prepared') {
      row.status = 'pending';
      return [{ message_id: row.message_id }];
    }
    if (/SET status = 'sent'/.test(sql) && row?.status === 'pending') {
      row.status = 'sent';
      return [{ updated_at: new Date(5) }];
    }
    return [];
  });
}

test('HTTP: opt-in Idempotency-Key on a poll: derived id, claim before the send, replay deduplicated', async () => {
  useAccount('personal');
  const { restore } = stubSendAttempts();
  const { client, seen } = recordingClient();
  Object.assign(client, { isIngestEnabled: () => true });
  try {
    await withRouter(client, ON, async call => {
      const headers = { 'idempotency-key': 'poll-cena-1' };
      const first = (await (await call(VALID[0][0], VALID[0][1], headers)).json()) as Record<string, unknown>;
      assert.match(String(first.messageId), /^3EB0[0-9A-F]{18}$/);
      assert.equal(first.sentAt, new Date(5).toISOString());
      const replay = (await (await call(VALID[0][0], VALID[0][1], headers)).json()) as Record<string, unknown>;
      assert.equal(replay.deduplicated, true);
      assert.equal(replay.messageId, first.messageId);
      const reused = await call(VALID[0][0], { ...VALID[0][1], name: 'Otra' }, headers);
      assert.equal(reused.status, 409);
      assert.equal(((await reused.json()) as { failureClass: string }).failureClass, 'idempotency_key_reused');
    });
    assert.equal(seen.length, 1, 'one poll reached the client');
  } finally {
    restore();
  }
});

/** A client whose four sends claim right before the network, like the real ones, and can fail after it. */
function claimingClient(): { client: Partial<BaileysClient>; sent: string[]; failAfterClaim: { on: boolean } } {
  const sent: string[] = [];
  const failAfterClaim = { on: false };
  const send = (kind: string) => async (...args: any[]) => {
    const options = args[args.length - 1] as { messageId?: string; beforeSend?: () => Promise<void> };
    await options?.beforeSend?.();
    if (failAfterClaim.on) throw new Error('timeout after the network send');
    sent.push(kind);
    return { messageId: options?.messageId || `${kind}-${sent.length}`, conversationId: GROUP, sentAt: 't' };
  };
  const client = {
    isConnected: () => true,
    getCachedState: () => 'CONNECTED',
    isIngestEnabled: () => true,
    sendPoll: send('poll'),
    sendPollVote: send('vote'),
    sendEvent: send('event'),
    respondToEvent: send('respond'),
  };
  return { client: client as unknown as Partial<BaileysClient>, sent, failAfterClaim };
}

/** The same request with one field changed: the body a key must not be reused for. */
const OTHER_BODY: Record<string, Record<string, unknown>> = {
  '/messages/poll': { name: 'Otra' },
  '/messages/poll/vote': { options: ['No'] },
  '/messages/event': { name: 'Otra' },
  '/messages/event/respond': { response: 'maybe' },
};

test('HTTP: a retry with the same Idempotency-Key of poll, vote, event or response sends nothing twice', async () => {
  useAccount('personal');
  const { restore } = stubSendAttempts();
  const { client, sent, failAfterClaim } = claimingClient();
  try {
    await withRouter(client, ON, async call => {
      for (const [path, body] of VALID) {
        const before = sent.length;
        const headers = { 'idempotency-key': `key-${path}` };
        const first = await call(path, body, headers);
        assert.equal(first.status, 200, path);
        const firstBody = (await first.json()) as Record<string, unknown>;
        assert.match(String(firstBody.messageId), /^3EB0[0-9A-F]{18}$/, path);
        const replay = await call(path, body, headers);
        assert.equal(replay.status, 200, path);
        const replayBody = (await replay.json()) as Record<string, unknown>;
        assert.equal(replayBody.deduplicated, true, path);
        assert.equal(replayBody.messageId, firstBody.messageId, path);
        const reused = await call(path, { ...body, ...OTHER_BODY[path] }, headers);
        assert.equal(reused.status, 409, path);
        assert.equal(((await reused.json()) as { failureClass: string }).failureClass, 'idempotency_key_reused');
        assert.equal(sent.length, before + 1, `${path}: one send for three requests`);

        // The outcome is lost after the network send: the retry is uncertain and is not sent again.
        const uncertain = { 'idempotency-key': `lost-${path}` };
        failAfterClaim.on = true;
        assert.ok((await call(path, body, uncertain)).status >= 500, `${path}: the failed send is an error`);
        failAfterClaim.on = false;
        const retried = await call(path, body, uncertain);
        assert.equal(retried.status, 409, path);
        assert.equal(((await retried.json()) as { failureClass: string }).failureClass, 'send_outcome_uncertain');
        assert.equal(sent.length, before + 1, `${path}: the lost send is not repeated`);
      }
    });
  } finally {
    restore();
  }
});

test('HTTP: without an Idempotency-Key the four sends are as before; a constant sendToken never deduplicates', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  const { client, sent } = claimingClient();
  try {
    await withRouter(client, ON, async call => {
      for (const [path, body] of VALID) {
        const withToken = { ...body, sendToken: 'one-token-for-everything' };
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await call(path, withToken);
          assert.equal(res.status, 200, path);
          assert.equal(((await res.json()) as { deduplicated?: boolean }).deduplicated, undefined, path);
        }
      }
    });
    assert.equal(sent.length, 8, 'every request sent');
    assert.equal(calls.filter(c => /whatsapp_send_attempts/.test(c.sql)).length, 0, 'no key, no table');
  } finally {
    restore();
  }
  // A client that reuses the token with a different key each time gets its own send, never a 409 or another result.
  const keyed = stubSendAttempts();
  const second = claimingClient();
  try {
    await withRouter(second.client, ON, async call => {
      for (const [path, body] of VALID) {
        const ids = new Set<unknown>();
        for (const key of ['a', 'b']) {
          const res = await call(
            path,
            { ...body, sendToken: 'one-token-for-everything', ...(key === 'b' ? OTHER_BODY[path] : {}) },
            { 'idempotency-key': `${key}-${path}` }
          );
          assert.equal(res.status, 200, path);
          ids.add(((await res.json()) as { messageId: string }).messageId);
        }
        assert.equal(ids.size, 2, `${path}: two keys, two sends`);
      }
    });
    assert.equal(second.sent.length, 8);
  } finally {
    keyed.restore();
  }
});
