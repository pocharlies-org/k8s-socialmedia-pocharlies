import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import pg from 'pg';
import { aesEncryptGCM, decryptPollVote, getKeyAuthor, hmacSign, proto, sha256 } from '@whiskeysockets/baileys';
import { BaileysClient } from './baileys-client';
import { generateHMACSignature } from './api/auth';
import { createRouter } from './api/controller';
import { CapabilityError } from './whatsapp-capabilities';
import {
  aggregateCapturedPollVotes,
  buildPollVoteContent,
  decryptCapturedPollVotes,
  parsePollCreationContent,
  pollEncKeyFromStoredMessage,
  validatePollVoteSelection,
  type CapturedPollVote,
  type PollCreationDetails,
} from './poll-votes';

process.env.CONNECTOR_ACCOUNT = 'professional';

const ME = '346000000000@s.whatsapp.net';
const CHAT = '346000000000-123456789@g.us';
const ENC_KEY = new Uint8Array(randomBytes(32));
const POLL_ID = 'POLLHIST1';
const CREATION_KEY = { remoteJid: CHAT, id: POLL_ID, fromMe: true };
const DETAILS: PollCreationDetails = {
  question: 'Q',
  options: ['Uno', 'Dos', 'Tres'],
  selectableCount: 1,
};
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const optionHash = (name: string) => hex(sha256(Buffer.from(name)));

/** Encrypt a vote as an arbitrary voter, mirroring Baileys' decryptPollVote. */
function voteUpdateContent(
  voterJid: string,
  optionNames: string[],
  senderTimestampMs: number,
  encKey: Uint8Array = ENC_KEY
) {
  const sign = Buffer.concat([
    Buffer.from(POLL_ID),
    Buffer.from(ME), // the poll was created by ME, so author = ME
    Buffer.from(voterJid),
    Buffer.from('Poll Vote'),
    new Uint8Array([1]),
  ]);
  const key0 = hmacSign(Buffer.from(encKey), new Uint8Array(32), 'sha256');
  const key = hmacSign(sign, key0, 'sha256');
  const aad = Buffer.from(`${POLL_ID}\u0000${voterJid}`);
  const iv = randomBytes(8);
  const plaintext = proto.Message.PollVoteMessage.encode({
    selectedOptions: optionNames.map(name => new Uint8Array(sha256(Buffer.from(name)))),
  }).finish();
  const encPayload = aesEncryptGCM(plaintext, key, iv, aad);
  return {
    pollUpdateMessage: {
      pollCreationMessageKey: { remoteJid: CHAT, fromMe: true, id: POLL_ID },
      vote: { encPayload, encIv: iv },
      senderTimestampMs,
    },
  };
}

function creationContent(messageSecret: Uint8Array | undefined) {
  return {
    pollCreationMessageV3: {
      name: DETAILS.question,
      options: DETAILS.options.map(optionName => ({ optionName })),
      selectableOptionsCount: 1,
    },
    ...(messageSecret
      ? { messageContextInfo: { messageSecret } }
      : {}),
  };
}

interface QueryCall {
  sql: string;
  params: unknown[];
}

function stubPayloadTable(payloads: Record<string, unknown>[]): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    if (/FROM conversations|SELECT id FROM conversations/i.test(sql))
      return Promise.resolve({ rows: [] });
    if (/pollUpdateMessage/i.test(sql))
      return Promise.resolve({ rows: payloads.filter(p => p.kind === 'update').map(p => p.row) });
    if (/SELECT message_key, message_payload|SELECT wa_message_id/i.test(sql))
      return Promise.resolve({
        rows: payloads.filter(p => p.kind === 'creation').map(p => p.row),
      });
    return Promise.resolve({ rows: [] });
  };
  return { calls, restore: () => ((pg.Pool.prototype as any).query = original) };
}

function stubPollVoteAttemptTable(): { restore: () => void } {
  const original = pg.Pool.prototype.query;
  const rows = new Map<string, {
    request_hash: string;
    message_id: string;
    status: 'prepared' | 'pending' | 'sent';
    sent_at: Date | null;
  }>();
  (pg.Pool.prototype as any).query = async (sql: string, params: string[] = []) => {
    if (sql.includes('CREATE TABLE')) return { rowCount: 0, rows: [] };
    const key = `${params[0]}:${params[1]}`;
    if (sql.includes('INSERT INTO whatsapp_send_attempts')) {
      if (rows.has(key)) return { rowCount: 0, rows: [] };
      rows.set(key, { request_hash: params[2], message_id: params[3], status: 'prepared', sent_at: null });
      return { rowCount: 1, rows: [{ message_id: params[3] }] };
    }
    const row = rows.get(key);
    if (sql.includes('SELECT request_hash'))
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    if (sql.includes('UPDATE whatsapp_send_attempts')) {
      if (!row || row.message_id !== params[2]) return { rowCount: 0, rows: [] };
      if (sql.includes("SET status = 'pending'")) {
        if (row.status !== 'prepared') return { rowCount: 0, rows: [] };
        row.status = 'pending';
        return { rowCount: 1, rows: [{ message_id: row.message_id }] };
      }
      if (row.status !== 'pending') return { rowCount: 0, rows: [] };
      row.status = 'sent';
      row.sent_at = new Date('2026-01-01T00:00:00Z');
      return { rowCount: 1, rows: [{ sent_at: row.sent_at }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  return { restore: () => ((pg.Pool.prototype as any).query = original) };
}

function rawRow(id: string, key: Record<string, unknown>, content: unknown) {
  return {
    wa_message_id: `professional:${id}`,
    message_key: key,
    message_payload: content,
    message_timestamp_ms: 1727000000000,
  };
}

test('buildPollVoteContent output is readable by Baileys own decryptPollVote', () => {
  const content = buildPollVoteContent({
    pollCreationKey: CREATION_KEY,
    pollEncKey: ENC_KEY,
    optionNames: ['Dos'],
    meJid: ME,
    iv: new Uint8Array(8).fill(7),
    senderTimestampMs: 1727000000000,
  });
  assert.equal(getKeyAuthor(CREATION_KEY, ME), ME);
  const vote = content.pollUpdateMessage?.vote;
  assert.ok(vote?.encPayload && vote.encIv);
  const decrypted = decryptPollVote(
    { encPayload: vote.encPayload as Uint8Array, encIv: vote.encIv as Uint8Array },
    { pollCreatorJid: ME, pollMsgId: POLL_ID, pollEncKey: ENC_KEY, voterJid: ME }
  );
  assert.deepEqual(
    (decrypted.selectedOptions ?? []).map(option => hex(option)),
    [optionHash('Dos')]
  );
});

test('multi-option vote round-trips and keeps creation key identity in payload', () => {
  const content = buildPollVoteContent({
    pollCreationKey: { ...CREATION_KEY, participant: '44@lid' },
    pollEncKey: ENC_KEY,
    optionNames: ['Uno', 'Tres'],
    meJid: ME,
  });
  assert.equal(content.pollUpdateMessage?.pollCreationMessageKey?.id, POLL_ID);
  assert.equal(content.pollUpdateMessage?.pollCreationMessageKey?.participant, '44@lid');
  const vote = content.pollUpdateMessage!.vote!;
  const decrypted = decryptPollVote(
    { encPayload: vote.encPayload as Uint8Array, encIv: vote.encIv as Uint8Array },
    { pollCreatorJid: ME, pollMsgId: POLL_ID, pollEncKey: ENC_KEY, voterJid: ME }
  );
  assert.deepEqual((decrypted.selectedOptions ?? []).map(o => hex(o)).sort(), [
    optionHash('Tres'),
    optionHash('Uno'),
  ].sort());
});

test('aggregation keeps only the latest vote per voter and never invents options', () => {
  const votes: CapturedPollVote[] = [
    { voterJid: 'v1', fromMe: false, senderTimestampMs: 10, selectedHashes: [optionHash('Uno')] },
    { voterJid: 'v1', fromMe: false, senderTimestampMs: 20, selectedHashes: [optionHash('Dos')] },
    { voterJid: ME, fromMe: true, senderTimestampMs: 15, selectedHashes: [optionHash('Uno')] },
    { voterJid: 'v3', fromMe: false, senderTimestampMs: 12, selectedHashes: ['ff'.repeat(32)] },
  ];
  const result = aggregateCapturedPollVotes(DETAILS, votes);
  assert.deepEqual(result.options, [
    { name: 'Uno', count: 1, selectedByMe: true },
    { name: 'Dos', count: 1, selectedByMe: false },
    { name: 'Tres', count: 0, selectedByMe: false },
  ]);
  assert.equal(result.totalVoters, 3);
  assert.equal(result.capturedVotes, 4);
});

test('option validation is exact, deduplicated and honours selectableCount semantics', () => {
  assert.deepEqual(validatePollVoteSelection(DETAILS, ['Uno']), ['Uno']);
  assert.throws(
    () => validatePollVoteSelection(DETAILS, [' Uno']),
    error => {
      assert.ok(error instanceof CapabilityError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'INVALID_CAPABILITY_INPUT');
      assert.deepEqual(error.details?.validOptions, DETAILS.options);
      return true;
    }
  );
  assert.throws(
    () => validatePollVoteSelection(DETAILS, ['Uno', 'Dos']),
    /at most 1 option/
  );
  assert.throws(() => validatePollVoteSelection(DETAILS, ['Uno', 'Uno']), /repeat/);
  assert.throws(() => validatePollVoteSelection(DETAILS, ['  ']), /non-empty strings/);
  assert.deepEqual(validatePollVoteSelection(DETAILS, []), []);
  assert.throws(() => validatePollVoteSelection(DETAILS, null), /must be an array/);
  const unlimited: PollCreationDetails = { ...DETAILS, selectableCount: 0 };
  assert.deepEqual(
    validatePollVoteSelection(unlimited, ['Uno', 'Dos', 'Tres']),
    ['Uno', 'Dos', 'Tres']
  );
  assert.throws(() => validatePollVoteSelection(unlimited, ['Uno', 'Nope']), /Unknown poll option/);
});

test('poll creation parsing covers V1/V3/V5 variants and unlimited counts', () => {
  const base = {
    name: 'Q',
    options: [{ optionName: 'A' }, { optionName: 'B' }],
  };
  for (const variant of ['pollCreationMessage', 'pollCreationMessageV3', 'pollCreationMessageV5']) {
    const details = parsePollCreationContent({
      [variant]: { ...base, selectableOptionsCount: 2 },
    });
    assert.ok(details);
    assert.deepEqual(details.options, ['A', 'B']);
    assert.equal(details.selectableCount, 2);
  }
  const unlimited = parsePollCreationContent({ [ 'pollCreationMessage']: { ...base } });
  assert.equal(unlimited?.selectableCount, 0);
  assert.equal(parsePollCreationContent({ conversation: 'hola' }), null);
});

test('poll encKey is read from top-level and nested messageContextInfo only when 32 bytes', () => {
  assert.deepEqual(pollEncKeyFromStoredMessage(creationContent(ENC_KEY)), ENC_KEY);
  assert.deepEqual(
    pollEncKeyFromStoredMessage({
      pollCreationMessageV3: {
        name: 'Q',
        options: [{ optionName: 'A' }],
        messageContextInfo: { messageSecret: ENC_KEY },
      },
    }),
    ENC_KEY
  );
  assert.equal(pollEncKeyFromStoredMessage(creationContent(new Uint8Array(16))), null);
  assert.equal(pollEncKeyFromStoredMessage({ conversation: 'x' }), null);
});

test('captured votes decrypt through ephemeral wrappers and count failures honestly', () => {
  const rows = [
    { key: { remoteJid: CHAT, id: 'VOTE1', fromMe: false, participant: 'voter2@s.whatsapp.net' },
      content: voteUpdateContent('voter2@s.whatsapp.net', ['Uno'], 1727000000000) },
    { key: { remoteJid: CHAT, id: 'VOTE2', fromMe: false, participant: 'voter3@s.whatsapp.net' },
      content: { ephemeralMessage: { message: voteUpdateContent('voter3@s.whatsapp.net', ['Dos'], 1727000001000) } } },
    { key: { remoteJid: CHAT, id: 'VOTE4', fromMe: false, participant: 'voter4@s.whatsapp.net' },
      content: voteUpdateContent('voter4@s.whatsapp.net', ['Tres'], 1727000002000, new Uint8Array(randomBytes(32))) },
  ];
  const result = decryptCapturedPollVotes(rows, { pollMsgId: POLL_ID, pollEncKey: ENC_KEY, meJid: ME });
  assert.equal(result.votes.length, 2);
  assert.equal(result.undecryptable, 1);
  assert.deepEqual(result.votes[0].selectedHashes, [optionHash('Uno')]);
  assert.equal(result.votes[1].senderTimestampMs, 1727000001000);
});

test('captured group votes use the encrypted LID even when a PN alias is present', () => {
  const voterLid = '123456789@lid';
  const rows = [{
    key: { remoteJid: CHAT, id: 'VOTE_LID', fromMe: false, participant: voterLid,
      participantAlt: '346000000001@s.whatsapp.net' },
    content: voteUpdateContent(voterLid, ['Dos'], 1727000002000),
  }];
  const result = decryptCapturedPollVotes(rows, { pollMsgId: POLL_ID, pollEncKey: ENC_KEY, meJid: ME });
  assert.equal(result.undecryptable, 0);
  assert.equal(result.votes.length, 1);
  assert.equal(result.votes[0].voterJid, voterLid);
  assert.deepEqual(result.votes[0].selectedHashes, [optionHash('Dos')]);
});

function clientWithFakeSock(): { client: BaileysClient; relayed: unknown[] } {
  const relayed: unknown[] = [];
  const client = new BaileysClient('/tmp/poll-votes-test-session', 'a'.repeat(32));
  (client as any).ready = true;
  (client as any).meJid = ME;
  (client as any).sock = {
    user: { id: ME },
    relayMessage: async (jid: string, message: unknown, options: unknown) => {
      relayed.push({ jid, message, options });
      return 'RELAYED';
    },
  };
  return { client, relayed };
}

test('getPollResults echoes unprefixed ids, caps to local_partial and hides identities', async () => {
  const payloads = [
    { kind: 'creation', row: rawRow(POLL_ID, { remoteJid: CHAT, id: POLL_ID, fromMe: true }, creationContent(ENC_KEY)) },
    { kind: 'update', row: rawRow('VOTE_ME', { remoteJid: CHAT, id: 'VOTE_ME', fromMe: true }, voteUpdateContent(ME, ['Uno'], 1727000000000)) },
    { kind: 'update', row: rawRow('VOTE_WRAP', { remoteJid: CHAT, id: 'VOTE_WRAP', fromMe: false, participant: 'voter9@lid' },
      { ephemeralMessage: { message: voteUpdateContent('voter9@lid', ['Dos'], 1727000001000) } }) },
  ];
  const { restore } = stubPayloadTable(payloads as any);
  try {
    const { client } = clientWithFakeSock();
    const polls = await client.getPollResults(CHAT, [POLL_ID, 'UNKNOWNID']);
    assert.equal(polls.length, 2);
    assert.deepEqual(polls.map(poll => poll.pollMessageId), [POLL_ID, 'UNKNOWNID']);
    const [known, unknown] = polls;
    assert.equal(known.available, true);
    assert.equal(known.availability, 'local_partial');
    assert.equal(known.capturedVotes, 2);
    assert.equal(known.totalVoters, 2);
    assert.equal(known.decryptionFailures, 0);
    assert.deepEqual(known.options, [
      { name: 'Uno', count: 1, selectedByMe: true },
      { name: 'Dos', count: 1, selectedByMe: false },
      { name: 'Tres', count: 0, selectedByMe: false },
    ]);
    assert.equal(unknown.available, false);
    assert.equal(unknown.availability, 'unavailable');
    assert.equal(unknown.reason, 'NO_LOCAL_DATA');
    const serialized = JSON.stringify(polls);
    for (const forbidden of ['voter9', '@s.whatsapp.net', '@g.us', 'participant', 'voters', 'messageSecret'])
      assert.ok(!serialized.includes(forbidden), `payload must not expose ${forbidden}`);
  } finally {
    restore();
  }
});

test('sendPollVote relays first, replacement and withdrawal votes as complete selections', async () => {
  const payloads = [
    { kind: 'creation', row: rawRow(POLL_ID, { remoteJid: CHAT, id: POLL_ID, fromMe: true }, creationContent(ENC_KEY)) },
  ];
  const { restore } = stubPayloadTable(payloads as any);
  try {
    const { client, relayed } = clientWithFakeSock();
    const selections = [['Uno'], ['Dos'], []];
    for (const options of selections) {
      assert.equal(await client.sendPollVote(CHAT, { pollMessageId: POLL_ID, options }), 'RELAYED');
    }
    assert.equal(relayed.length, 3);
    for (const [index, sent] of relayed.entries()) {
      const { jid, message, options } = sent as { jid: string; message: any; options: { messageId: string } };
      assert.equal(jid, CHAT);
      assert.equal(message.pollUpdateMessage.pollCreationMessageKey.id, POLL_ID);
      assert.ok(options.messageId);
      const vote = message.pollUpdateMessage.vote;
      const decrypted = decryptPollVote(
        { encPayload: vote.encPayload, encIv: vote.encIv },
        { pollCreatorJid: ME, pollMsgId: POLL_ID, pollEncKey: ENC_KEY, voterJid: ME }
      );
      assert.deepEqual((decrypted.selectedOptions ?? []).map(o => hex(o)), selections[index].map(optionHash));
    }
    assert.equal(new Set(relayed.map(item => (item as any).options.messageId)).size, 3);
  } finally {
    restore();
  }
});

test('withdrawal supersedes an earlier vote without leaving a selected option or voter', () => {
  const rows = [
    { key: { ...CREATION_KEY, id: 'VOTE_FIRST' }, content: voteUpdateContent(ME, ['Uno'], 10) },
    { key: { ...CREATION_KEY, id: 'VOTE_WITHDRAW' }, content: voteUpdateContent(ME, [], 20) },
  ];
  const decrypted = decryptCapturedPollVotes(rows, { pollMsgId: POLL_ID, pollEncKey: ENC_KEY, meJid: ME });
  assert.equal(decrypted.undecryptable, 0);
  assert.deepEqual(aggregateCapturedPollVotes(DETAILS, decrypted.votes).options, [
    { name: 'Uno', count: 0, selectedByMe: false },
    { name: 'Dos', count: 0, selectedByMe: false },
    { name: 'Tres', count: 0, selectedByMe: false },
  ]);
  assert.equal(aggregateCapturedPollVotes(DETAILS, decrypted.votes).totalVoters, 0);
});

test('sendPollVote only reports a vote after transport resolves, even if persistence fails', async () => {
  const { restore } = stubPayloadTable([
    { kind: 'creation', row: rawRow(POLL_ID, CREATION_KEY, creationContent(ENC_KEY)) },
  ] as any);
  try {
    const { client, relayed } = clientWithFakeSock();
    (client as any).persistSentMessage = async () => { throw new Error('storage unavailable'); };
    (client as any).logger = { warn: () => {} };
    assert.equal(await client.sendPollVote(CHAT, { pollMessageId: POLL_ID, options: ['Uno'] }), 'RELAYED');
    assert.equal(relayed.length, 1);
    (client as any).sock.relayMessage = async () => { throw new Error('transport unavailable'); };
    await assert.rejects(
      client.sendPollVote(CHAT, { pollMessageId: POLL_ID, options: ['Dos'] }),
      /transport unavailable/
    );
    assert.equal(relayed.length, 1);
    (client as any).sock.relayMessage = async () => undefined;
    assert.equal(await client.sendPollVote(CHAT, { pollMessageId: POLL_ID, options: [] }), undefined);
  } finally {
    restore();
  }
});

test('sendPollVote claims its stable message ID before relaying', async () => {
  const { restore } = stubPayloadTable([
    { kind: 'creation', row: rawRow(POLL_ID, CREATION_KEY, creationContent(ENC_KEY)) },
  ] as any);
  try {
    const { client, relayed } = clientWithFakeSock();
    const reservedId = '3EB0ABCDEF0123456789';
    let claimed = false;
    (client as any).sock.relayMessage = async (_jid: string, _message: unknown, options: { messageId: string }) => {
      assert.equal(claimed, true);
      assert.equal(options.messageId, reservedId);
      relayed.push(options);
      return reservedId;
    };
    assert.equal(
      await client.sendPollVote(CHAT, { pollMessageId: POLL_ID, options: ['Uno'] }, reservedId, async () => { claimed = true; }),
      reservedId
    );
    assert.equal(relayed.length, 1);
    await assert.rejects(
      client.sendPollVote(CHAT, { pollMessageId: POLL_ID, options: ['Dos'] }, reservedId, async () => { throw new Error('claim failed'); }),
      /claim failed/
    );
    assert.equal(relayed.length, 1);
  } finally {
    restore();
  }
});

test('poll vote API retries a lost response without another relay and accepts a new choice token', async () => {
  const secret = 'poll-vote-fixture';
  const calls: unknown[] = [];
  let transportFails = false;
  const { restore } = stubPollVoteAttemptTable();
  const app = express();
  app.use(express.json());
  app.use(createRouter({
    sendPollVote: async (chatId: string, input: unknown, _messageId: string, beforeSend: () => Promise<void>) => {
      await beforeSend();
      calls.push({ chatId, input });
      if (transportFails) throw new Error('transport unavailable');
      return undefined;
    },
  } as any, { getCurrentQR: () => null } as any, secret));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const priorEnabled = process.env.ENABLE_SENDING;
  const priorEmergency = process.env.EMERGENCY_DISABLE_SENDING;
  process.env.ENABLE_SENDING = 'true';
  delete process.env.EMERGENCY_DISABLE_SENDING;
  try {
    const body = { conversationId: CHAT, pollMessageId: POLL_ID, options: [], sendToken: 'withdraw-1' };
    const post = (payload: unknown) => {
      const timestamp = Math.floor(Date.now() / 1000);
      return fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/messages/poll/vote`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
          'content-type': 'application/json',
          'x-connector-timestamp': String(timestamp),
          'x-connector-signature': generateHMACSignature(payload, timestamp, secret),
        },
      });
    };
    const accepted = await post(body);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, messageId: null, sent: true, deduplicated: false });
    assert.deepEqual(calls, [{ chatId: CHAT, input: { pollMessageId: POLL_ID, options: [] } }]);
    const retried = await post(body);
    assert.equal(retried.status, 200);
    const retriedBody = await retried.json() as { ok: boolean; messageId: string; sent: boolean; deduplicated: boolean };
    assert.equal(retriedBody.ok, true);
    assert.match(retriedBody.messageId, /^3EB0[A-F0-9]{18}$/);
    assert.equal(retriedBody.sent, true);
    assert.equal(retriedBody.deduplicated, true);
    assert.equal(calls.length, 1);
    const conflict = await post({ ...body, options: ['Uno'] });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: { code: string } }).error.code, 'POLL_VOTE_TOKEN_CONFLICT');
    assert.equal(calls.length, 1);
    const changed = await post({ ...body, sendToken: 'choose-2', options: ['Dos'] });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json() as { deduplicated: boolean }).deduplicated, false);
    assert.deepEqual(calls[1], { chatId: CHAT, input: { pollMessageId: POLL_ID, options: ['Dos'] } });
    assert.equal(calls.length, 2);
    const noToken = await post({ ...body, sendToken: undefined });
    assert.equal(noToken.status, 400);
    transportFails = true;
    const uncertain = { ...body, sendToken: 'uncertain-3', options: ['Tres'] };
    assert.equal((await post(uncertain)).status, 409);
    assert.equal((await post(uncertain)).status, 409);
    assert.equal(calls.length, 3);
  } finally {
    restore();
    if (priorEnabled === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = priorEnabled;
    if (priorEmergency === undefined) delete process.env.EMERGENCY_DISABLE_SENDING;
    else process.env.EMERGENCY_DISABLE_SENDING = priorEmergency;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('sendPollVote rejects unknown options, missing polls and missing encKeys with contract codes', async () => {
  const { restore: restoreOk } = stubPayloadTable([
    { kind: 'creation', row: rawRow(POLL_ID, { remoteJid: CHAT, id: POLL_ID, fromMe: true }, creationContent(ENC_KEY)) },
  ] as any);
  try {
    const { client } = clientWithFakeSock();
    await assert.rejects(
      client.sendPollVote(CHAT, { pollMessageId: POLL_ID, options: ['Cuatro'] }),
      error => error instanceof CapabilityError && error.status === 400
    );
    await assert.rejects(
      client.sendPollVote(CHAT, { pollMessageId: '', options: ['Uno'] }),
      error => error instanceof CapabilityError && error.status === 400
    );
  } finally {
    restoreOk();
  }
  const { restore: restoreNoKey } = stubPayloadTable([
    { kind: 'creation', row: rawRow(POLL_ID, { remoteJid: CHAT, id: POLL_ID, fromMe: true }, creationContent(undefined)) },
  ] as any);
  try {
    const { client } = clientWithFakeSock();
    await assert.rejects(
      client.sendPollVote(CHAT, { pollMessageId: POLL_ID, options: ['Uno'] }),
      error =>
        error instanceof CapabilityError &&
        error.status === 409 &&
        error.code === 'POLL_ENCRYPTION_KEY_UNAVAILABLE'
    );
  } finally {
    restoreNoKey();
  }
  const { restore: restoreEmpty } = stubPayloadTable([] as any);
  try {
    const { client } = clientWithFakeSock();
    await assert.rejects(
      client.sendPollVote(CHAT, { pollMessageId: 'MISSING', options: ['Uno'] }),
      error => error instanceof CapabilityError && error.status === 404 && error.code === 'POLL_NOT_FOUND'
    );
  } finally {
    restoreEmpty();
  }
});
