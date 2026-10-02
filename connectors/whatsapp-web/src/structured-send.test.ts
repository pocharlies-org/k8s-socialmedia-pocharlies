import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import pg from 'pg';
import { generateWAMessageContent, proto } from '@whiskeysockets/baileys';
import { BaileysClient } from './baileys-client';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';
import {
  claimSendAttempt,
  reserveEventCreationSend,
  reservePollSend,
  SendAlreadyClaimedError,
  type SendReservation,
} from './send-idempotency';
import {
  prepareEventInput,
  preparePollInput,
  sendEventOnce,
  sendPollOnce,
  sendTokenOrLegacy,
  StructuredSendError,
  type PreparedEvent,
  type PreparedPoll,
} from './structured-send';

/**
 * Provider-free tests for the two created messages (poll, event). Nothing here
 * opens a WhatsApp socket: the provider appears either as the installed rc13
 * message builder/proto, or as a `sendMessage` stand-in that records what the
 * connector would have handed it.
 */

const STABLE_ID = '3EB0AABBCCDDEEFF001122';
const POLL = {
  token: 'poll-token',
  conversationId: '111@s.whatsapp.net',
  name: 'Comida?',
  values: ['Pizza', 'Sushi'],
};
const EVENT = {
  token: 'event-token',
  conversationId: '123@g.us',
  name: 'Cena',
  startDate: '2026-09-28T16:00:00.000Z',
};

function structuredError(code: string, status: number) {
  return (error: unknown) =>
    error instanceof StructuredSendError && error.code === code && error.status === status;
}

/** The same in-memory send-attempt table the HTTP tests in send-idempotency use. */
function installSendStore(): { restore: () => void } {
  const original = pg.Pool.prototype.query;
  const rows = new Map<
    string,
    { request_hash: string; message_id: string; status: string; sent_at: Date | null }
  >();
  (pg.Pool.prototype as any).query = async (sql: string, params: any[] = []) => {
    if (sql.includes('CREATE TABLE')) return { rowCount: 0, rows: [] };
    const key = `${params[0]}:${params[1]}`;
    if (sql.includes('INSERT INTO whatsapp_send_attempts')) {
      if (rows.has(key)) return { rowCount: 0, rows: [] };
      rows.set(key, {
        request_hash: params[2],
        message_id: params[3],
        status: 'prepared',
        sent_at: null,
      });
      return { rowCount: 1, rows: [{ message_id: params[3] }] };
    }
    if (sql.includes('SELECT request_hash'))
      return { rowCount: rows.has(key) ? 1 : 0, rows: rows.has(key) ? [rows.get(key)] : [] };
    if (sql.includes('UPDATE whatsapp_send_attempts')) {
      const row = rows.get(key);
      if (!row || row.message_id !== params[2]) return { rowCount: 0, rows: [] };
      if (sql.includes("SET status = 'pending'")) {
        if (row.status !== 'prepared') return { rowCount: 0, rows: [] };
        row.status = 'pending';
        return { rowCount: 1, rows: [{ message_id: row.message_id }] };
      }
      if (row.status !== 'pending') return { rowCount: 0, rows: [] };
      row.status = 'sent';
      row.sent_at = new Date('2026-09-28T00:00:00.000Z');
      return { rowCount: 1, rows: [{ sent_at: row.sent_at }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  return { restore: () => ((pg.Pool.prototype as any).query = original) };
}

test('only an absent sendToken becomes a legacy id, a present broken one is refused', () => {
  const minted = [sendTokenOrLegacy(undefined), sendTokenOrLegacy(undefined)];
  for (const token of minted)
    assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(minted[0], minted[1]);
  assert.equal(sendTokenOrLegacy(' retry-7 '), 'retry-7');
  for (const unusable of [null, '', '   ', 42, true, {}, [], ['t'], 'x'.repeat(201)]) {
    assert.throws(
      () => sendTokenOrLegacy(unusable),
      structuredError('INVALID_SEND_TOKEN', 400),
      `expected ${JSON.stringify(unusable)} to be refused`
    );
  }
});

test('poll limits follow the provider and a rejected draft never reaches the sender', () => {
  const refused: Array<[string, Record<string, unknown>]> = [
    ['one option', { values: ['Pizza'] }],
    ['thirteen options', { values: Array.from({ length: 13 }, (_v, i) => `o${i}`) }],
    ['empty option', { values: ['Pizza', '   '] }],
    ['non-text option', { values: ['Pizza', 3] }],
    ['repeated option that only differs by spacing', { values: ['Pizza', ' Pizza '] }],
    ['option over 100 characters', { values: ['Pizza', 'x'.repeat(101)] }],
    ['options not a list', { values: 'Pizza,Sushi' }],
    ['no question', { name: '   ' }],
    ['question over 255 characters', { name: 'q'.repeat(256) }],
    ['selectableCount zero', { selectableCount: 0 }],
    ['selectableCount above the option count', { selectableCount: 3 }],
    ['selectableCount not a count', { selectableCount: 'two' }],
  ];
  for (const [label, change] of refused) {
    assert.throws(
      () => preparePollInput({ ...POLL, ...change }),
      structuredError('INVALID_POLL_REQUEST', 400),
      `expected the draft with ${label} to be refused`
    );
  }

  // Case is part of the answer, so "Pizza" and "pizza" stay two distinct options.
  assert.deepEqual(preparePollInput({ ...POLL, values: ['Pizza', 'pizza'] }).values, [
    'Pizza',
    'pizza',
  ]);

  const widest = preparePollInput({
    ...POLL,
    name: 'q'.repeat(255),
    values: ['x'.repeat(100), ...Array.from({ length: 11 }, (_v, i) => `o${i}`)],
    selectableCount: 12,
  });
  assert.equal(widest.name.length, 255);
  assert.equal(widest.values.length, 12);
  assert.equal(widest.selectableCount, 12);

  // Two answers is the default the official client sends, so the field stays out.
  assert.equal(preparePollInput(POLL).selectableCount, undefined);
  assert.equal(preparePollInput({ ...POLL, selectableCount: '2' }).selectableCount, 2);
  assert.deepEqual(preparePollInput({ ...POLL, values: ['  Pizza, grande  ', 'Sushi'] }).values, [
    'Pizza, grande',
    'Sushi',
  ]);
});

test('event validation keeps end after start and the location shape the creator typed', () => {
  const local = prepareEventInput({ ...EVENT, startDate: '2026-09-28T18:00:00+02:00' });
  assert.equal(local.startDate, '2026-09-28T16:00:00.000Z');
  assert.equal(
    prepareEventInput({ ...EVENT, endDate: '2026-09-28T16:00:00.000Z' }).endDate,
    '2026-09-28T16:00:00.000Z',
    'an event that ends when it starts is still a valid draft'
  );
  assert.throws(
    () => prepareEventInput({ ...EVENT, endDate: '2026-09-28T15:59:59.000Z' }),
    (error: unknown) =>
      structuredError('INVALID_EVENT_REQUEST', 400)(error) &&
      (error as StructuredSendError).details?.field === 'endDate'
  );

  // A typed place is a name; coordinates are only there when someone picked a pin.
  const named = prepareEventInput({ ...EVENT, location: { name: '  Bar Luna ' } });
  assert.deepEqual(named.location, { name: 'Bar Luna' });
  assert.equal('degreesLatitude' in (named.location as object), false);
  assert.deepEqual(
    prepareEventInput({ ...EVENT, location: { degreesLatitude: 0, degreesLongitude: 0 } }).location,
    { degreesLatitude: 0, degreesLongitude: 0 }
  );
  assert.deepEqual(
    prepareEventInput({
      ...EVENT,
      location: { name: 'Oficina', degreesLatitude: 40.4168, degreesLongitude: -3.7038 },
    }).location,
    { degreesLatitude: 40.4168, degreesLongitude: -3.7038, name: 'Oficina' }
  );
  assert.equal(prepareEventInput({ ...EVENT, location: { name: '   ' } }).location, undefined);
  for (const change of [
    { location: 'Bar Luna' },
    { location: { degreesLatitude: 40.4 } },
    { location: { degreesLongitude: -3.7 } },
    { location: { degreesLatitude: 91, degreesLongitude: 0 } },
    { location: { degreesLatitude: 40.4, degreesLongitude: 181 } },
    { location: { degreesLatitude: '', degreesLongitude: '' } },
    { location: { degreesLatitude: false, degreesLongitude: false } },
  ]) {
    assert.throws(
      () => prepareEventInput({ ...EVENT, ...change }),
      structuredError('INVALID_EVENT_REQUEST', 400),
      `expected ${JSON.stringify(change)} to be refused`
    );
  }

  for (const change of [
    { name: '  ' },
    { startDate: 'ayer' },
    { startDate: undefined },
    { endDate: 'manana' },
    { description: 7 },
    { call: 'fax' },
    { isCancelled: 'yes' },
    { extraGuestsAllowed: 1 },
  ]) {
    assert.throws(
      () => prepareEventInput({ ...EVENT, ...change }),
      structuredError('INVALID_EVENT_REQUEST', 400),
      `expected ${JSON.stringify(change)} to be refused`
    );
  }
  assert.equal(prepareEventInput({ ...EVENT, call: 'video' }).call, 'video');
  assert.equal(prepareEventInput({ ...EVENT, isCancelled: true }).isCancelled, true);
  assert.equal('description' in prepareEventInput({ ...EVENT, description: '   ' }), false);
});

test('a retry token belongs to one account, chat, message type and payload', async () => {
  const store = installSendStore();
  const previousAccount = process.env.CONNECTOR_ACCOUNT;
  try {
    process.env.CONNECTOR_ACCOUNT = 'personal';
    const poll = { ...POLL, selectableCount: 1 };
    const first = await reservePollSend(poll);
    assert.equal(first.state, 'claimed');
    assert.match(first.messageId, /^3EB0[A-F0-9]{18}$/);
    assert.deepEqual(await reservePollSend(poll), {
      state: 'prepared',
      messageId: first.messageId,
      sentAt: undefined,
    });
    for (const change of [
      { name: 'Cena?' },
      { values: ['Pizza', 'Sushi', 'Tacos'] },
      { selectableCount: 2 },
      { conversationId: '999@g.us' },
    ]) {
      assert.equal(
        (await reservePollSend({ ...poll, ...change })).state,
        'conflict',
        `a reused token with ${JSON.stringify(change)} is a different poll`
      );
    }

    // The same token cannot answer for another kind of message or another payload.
    assert.equal(
      (await reserveEventCreationSend({ ...EVENT, token: poll.token })).state,
      'conflict'
    );
    const event = await reserveEventCreationSend({
      ...EVENT,
      location: { name: 'Bar Luna' },
      extraGuestsAllowed: true,
    });
    assert.equal(event.state, 'claimed');
    for (const change of [
      { endDate: '2026-09-28T18:00:00.000Z' },
      { description: 'Traer vino' },
      { isCancelled: true },
      { call: 'video' as const },
      { conversationId: '456@g.us' },
      { location: { name: 'Otro bar' } },
      { location: { name: 'Bar Luna', degreesLatitude: 0, degreesLongitude: 0 } },
      { location: undefined },
    ]) {
      assert.equal(
        (
          await reserveEventCreationSend({
            ...EVENT,
            location: { name: 'Bar Luna' },
            extraGuestsAllowed: true,
            ...change,
          })
        ).state,
        'conflict',
        `a reused token with ${JSON.stringify(change)} is a different event`
      );
    }
    // Two spellings of one instant are one payload, so a retry still replays.
    const offset = await reserveEventCreationSend(
      prepareEventInput({
        ...EVENT,
        token: 'event-canonical',
        startDate: '2026-09-28T18:00:00+02:00',
      })
    );
    assert.equal(offset.state, 'claimed');
    assert.deepEqual(
      await reserveEventCreationSend(
        prepareEventInput({ ...EVENT, token: 'event-canonical', endDate: '' })
      ),
      { state: 'prepared', messageId: offset.messageId, sentAt: undefined }
    );

    process.env.CONNECTOR_ACCOUNT = 'professional';
    const otherAccount = await reservePollSend(poll);
    assert.equal(otherAccount.state, 'claimed');
    assert.notEqual(otherAccount.messageId, first.messageId);
  } finally {
    process.env.CONNECTOR_ACCOUNT = previousAccount === undefined ? 'personal' : previousAccount;
    if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
    store.restore();
  }
});

test('a poll is claimed before the relay, confirmed after, and a replay never relays again', async () => {
  const order: string[] = [];
  let claimed = false;
  let delivered = false;
  const ports = {
    reserve: async (): Promise<SendReservation> => ({
      state: delivered ? 'sent' : 'prepared',
      messageId: STABLE_ID,
      ...(delivered ? { sentAt: '2026-09-28T00:00:00.000Z' } : {}),
    }),
    claim: async () => {
      if (claimed) throw new SendAlreadyClaimedError();
      claimed = true;
      order.push('claim');
    },
    confirm: async () => {
      delivered = true;
      order.push('confirm');
      return '2026-09-28T00:00:00.000Z';
    },
    send: async (input: PreparedPoll, messageId: string, beforeSend: () => Promise<void>) => {
      await beforeSend();
      order.push('relay');
      assert.deepEqual(input.values, ['Pizza', 'Sushi']);
      return messageId;
    },
  };
  const first = await sendPollOnce(POLL, ports);
  assert.deepEqual(first, {
    messageId: STABLE_ID,
    sentAt: '2026-09-28T00:00:00.000Z',
    deduplicated: false,
  });
  assert.deepEqual(order, ['claim', 'relay', 'confirm']);
  const replay = await sendPollOnce(POLL, ports);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.messageId, STABLE_ID);
  assert.equal(order.length, 3, 'a completed send must not touch the provider again');
});

test('two concurrent creators of the same poll relay exactly once', async () => {
  let claimed = false;
  let delivered = false;
  let relays = 0;
  const ports = {
    reserve: async (): Promise<SendReservation> => ({
      state: delivered ? 'sent' : 'prepared',
      messageId: STABLE_ID,
    }),
    claim: async () => {
      if (claimed) throw new SendAlreadyClaimedError();
      claimed = true;
    },
    confirm: async () => {
      delivered = true;
      return '2026-09-28T00:00:00.000Z';
    },
    send: async (_input: PreparedPoll, messageId: string, beforeSend: () => Promise<void>) => {
      await beforeSend();
      relays++;
      return messageId;
    },
  };
  const settled = await Promise.allSettled([sendPollOnce(POLL, ports), sendPollOnce(POLL, ports)]);
  assert.equal(settled.filter(entry => entry.status === 'fulfilled').length, 1);
  assert.equal(relays, 1);
});

test('uncertain poll and event outcomes stay uncertain and are not replayed', async () => {
  await assert.rejects(
    sendPollOnce(POLL, {
      reserve: async () => ({ state: 'sent', messageId: STABLE_ID }),
      send: async () => {
        throw new Error('must not relay');
      },
    }),
    structuredError('POLL_SEND_OUTCOME_UNCERTAIN', 409)
  );
  for (const state of ['pending', 'conflict'] as const) {
    const expected = state === 'pending' ? 'POLL_SEND_OUTCOME_UNCERTAIN' : 'POLL_TOKEN_CONFLICT';
    await assert.rejects(
      sendPollOnce(POLL, {
        reserve: async () => ({ state, messageId: STABLE_ID }),
        send: async () => {
          throw new Error('must not relay');
        },
      }),
      structuredError(expected, 409)
    );
  }
  const postClaimFailures = [
    { label: 'transport', confirm: async () => '2026-09-28T00:00:00.000Z', relayFails: true },
    {
      label: 'confirmation',
      confirm: async () => {
        throw new Error('database down');
      },
      relayFails: false,
    },
  ];
  for (const variant of postClaimFailures) {
    await assert.rejects(
      sendPollOnce(POLL, {
        reserve: async () => ({ state: 'prepared', messageId: STABLE_ID }),
        claim: async () => undefined,
        confirm: variant.confirm,
        send: async (_input, messageId, beforeSend) => {
          await beforeSend();
          if (variant.relayFails) throw new Error('socket closed');
          return messageId;
        },
      }),
      structuredError('POLL_SEND_OUTCOME_UNCERTAIN', 409),
      variant.label
    );
  }
  await assert.rejects(
    sendEventOnce(EVENT, {
      reserve: async () => ({ state: 'prepared', messageId: STABLE_ID }),
      claim: async () => undefined,
      confirm: async () => '2026-09-28T00:00:00.000Z',
      send: async () => '3EB0OTHERMESSAGEID000000',
    }),
    structuredError('EVENT_CREATE_OUTCOME_UNCERTAIN', 409)
  );
});

test('a failure before the claim keeps the reservation usable for the next attempt', async () => {
  const store = installSendStore();
  const previousAccount = process.env.CONNECTOR_ACCOUNT;
  try {
    process.env.CONNECTOR_ACCOUNT = 'personal';
    const poll = { ...POLL, token: 'poll-retry-after-preflight' };
    await assert.rejects(
      sendPollOnce(poll, {
        send: async () => {
          throw new Error('session is not connected');
        },
      }),
      /session is not connected/
    );
    const after = await reservePollSend(poll);
    assert.equal(after.state, 'prepared', 'a send that never claimed must not burn the token');
    const result = await sendPollOnce(poll, {
      send: async (_input, messageId, beforeSend) => {
        await beforeSend();
        return messageId;
      },
    });
    assert.equal(result.messageId, after.messageId);
    assert.equal(result.deduplicated, false);
    assert.equal((await reservePollSend(poll)).state, 'sent');
  } finally {
    if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previousAccount;
    store.restore();
  }
});

interface Recorded {
  input: Record<string, unknown>;
  messageId: string;
  order: string[];
}

test('the poll and event routes keep the token, the option text and the typed location', async () => {
  const store = installSendStore();
  const previousAccount = process.env.CONNECTOR_ACCOUNT;
  const previousEnabled = process.env.ENABLE_SENDING;
  const polls: Recorded[] = [];
  const events: Recorded[] = [];
  let breakTheSocket = false;
  let failBeforeClaim = false;

  const client = {
    sendPoll: async (input: PreparedPoll, messageId: string, beforeSend: () => Promise<void>) => {
      const order: string[] = ['accepted'];
      if (failBeforeClaim) throw new Error('session is not connected');
      await beforeSend();
      order.push('claimed');
      if (breakTheSocket) throw new Error('socket closed after relay');
      order.push('relayed');
      polls.push({ input: input as unknown as Record<string, unknown>, messageId, order });
      return messageId;
    },
    sendEvent: async (input: PreparedEvent, messageId: string, beforeSend: () => Promise<void>) => {
      const order: string[] = ['accepted'];
      if (failBeforeClaim) throw new Error('session is not connected');
      await beforeSend();
      order.push('claimed');
      if (breakTheSocket) throw new Error('socket closed after relay');
      order.push('relayed');
      events.push({ input: input as unknown as Record<string, unknown>, messageId, order });
      return messageId;
    },
  } as unknown as BaileysClient;

  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client, { getCurrentQR: () => null } as any, 'test-secret'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    process.env.CONNECTOR_ACCOUNT = 'personal';
    process.env.ENABLE_SENDING = 'true';
    const address = server.address() as { port: number };
    async function post(path: string, body: Record<string, unknown>) {
      const timestamp = Math.floor(Date.now() / 1000);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-connector-timestamp': String(timestamp),
          'x-connector-signature': generateHMACSignature(body, timestamp, 'test-secret'),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    }

    const poll = {
      sendToken: 'poll-http',
      conversationId: '111@s.whatsapp.net',
      name: 'Comida?',
      values: ['Pizza, grande', 'Sushi'],
      selectableCount: 1,
    };
    const first = await post('/messages/poll', poll);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.sent, true);
    assert.equal(first.body.deduplicated, false);
    assert.match(first.body.messageId, /^3EB0[A-F0-9]{18}$/);
    assert.deepEqual(polls[0].input.values, ['Pizza, grande', 'Sushi']);
    assert.equal(polls[0].input.selectableCount, 1);
    assert.equal(polls[0].input.name, 'Comida?');
    assert.deepEqual(polls[0].order, ['accepted', 'claimed', 'relayed']);

    const replay = await post('/messages/poll', poll);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.messageId, first.body.messageId);
    assert.equal(replay.body.deduplicated, true);
    assert.equal(polls.length, 1, 'the route must hand the token to the reservation, not drop it');

    const changed = await post('/messages/poll', { ...poll, values: ['Pizza', 'Tacos'] });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'POLL_TOKEN_CONFLICT');
    assert.equal(polls.length, 1);

    // A rejected draft must not consume the token, so fixing it still sends.
    const thin = { ...poll, sendToken: 'poll-fix-me', values: ['Pizza'] };
    const refused = await post('/messages/poll', thin);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'INVALID_POLL_REQUEST');
    assert.equal(polls.length, 1);
    assert.equal(
      (await post('/messages/poll', { ...thin, values: ['Pizza', 'Sushi'] })).status,
      200
    );
    assert.equal(polls.length, 2);

    // Legacy clients that never send the field still get one relay per call.
    const { sendToken: _dropped, ...legacy } = poll;
    const legacyOne = await post('/messages/poll', legacy);
    const legacyTwo = await post('/messages/poll', legacy);
    assert.equal(legacyOne.status, 200);
    assert.equal(legacyTwo.status, 200);
    assert.notEqual(legacyOne.body.messageId, legacyTwo.body.messageId);
    assert.equal(legacyOne.body.deduplicated, false);
    assert.equal(polls.length, 4);

    for (const unusable of [null, '', 7, {}, 'x'.repeat(201)]) {
      const before = polls.length;
      const refusedToken = await post('/messages/poll', { ...poll, sendToken: unusable });
      assert.equal(refusedToken.status, 400, `${JSON.stringify(unusable)} must be refused`);
      assert.equal(refusedToken.body.error.code, 'INVALID_SEND_TOKEN');
      assert.equal(polls.length, before);
    }

    const event = {
      sendToken: 'event-http',
      conversationId: '123@g.us',
      name: 'Cena',
      description: 'Traer vino',
      startDate: '2026-09-28T16:00:00.000Z',
      endDate: '2026-09-28T18:00:00.000Z',
      location: { name: 'Bar Luna' },
    };
    const created = await post('/messages/event', event);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.deduplicated, false);
    assert.deepEqual(events[0].input.location, { name: 'Bar Luna' });
    assert.equal('degreesLatitude' in (events[0].input.location as object), false);
    assert.equal(events[0].input.startDate, '2026-09-28T16:00:00.000Z');
    assert.equal(events[0].input.endDate, '2026-09-28T18:00:00.000Z');

    assert.equal((await post('/messages/event', event)).body.deduplicated, true);
    assert.equal(events.length, 1);
    const movedPin = await post('/messages/event', {
      ...event,
      location: { name: 'Bar Luna', degreesLatitude: 0, degreesLongitude: 0 },
    });
    assert.equal(movedPin.status, 409);
    assert.equal(movedPin.body.error.code, 'EVENT_CREATE_TOKEN_CONFLICT');

    const tooLate = await post('/messages/event', {
      ...event,
      sendToken: 'event-end-before-start',
      endDate: '2026-09-28T15:59:59.000Z',
    });
    assert.equal(tooLate.status, 400);
    assert.equal(tooLate.body.error.details.field, 'endDate');
    assert.equal(events.length, 1);

    const { sendToken: _alsoDropped, ...legacyEvent } = event;
    assert.equal((await post('/messages/event', legacyEvent)).status, 200);
    assert.equal((await post('/messages/event', legacyEvent)).status, 200);
    assert.equal(events.length, 3);

    // A relay the provider never confirmed stays uncertain: the next call reports
    // it instead of quietly putting a second message in the chat.
    breakTheSocket = true;
    const lost = await post('/messages/poll', {
      ...poll,
      sendToken: 'poll-lost-ack',
      values: ['Pizza', 'Sushi'],
      selectableCount: 2,
    });
    breakTheSocket = false;
    assert.equal(lost.status, 409);
    assert.equal(lost.body.error.code, 'POLL_SEND_OUTCOME_UNCERTAIN');
    const stillUncertain = await post('/messages/poll', {
      ...poll,
      sendToken: 'poll-lost-ack',
      values: ['Pizza', 'Sushi'],
      selectableCount: 2,
    });
    assert.equal(stillUncertain.status, 409);
    assert.equal(stillUncertain.body.error.code, 'POLL_SEND_OUTCOME_UNCERTAIN');

    // A relay that failed before the claim consumed nothing, so the same token
    // can be used again once the session is back.
    failBeforeClaim = true;
    const preflight = { ...poll, sendToken: 'poll-preflight', values: ['Pizza', 'Sushi'] };
    assert.equal((await post('/messages/poll', preflight)).status, 500);
    failBeforeClaim = false;
    assert.equal((await post('/messages/poll', preflight)).status, 200);

    process.env.ENABLE_SENDING = 'false';
    const blocked = await post('/messages/poll', { ...poll, sendToken: 'poll-blocked' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'SENDING_DISABLED');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
    if (previousEnabled === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previousEnabled;
    if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previousAccount;
    store.restore();
  }
});

test('the client claims before relaying, pins the reserved id and survives a persist failure', async () => {
  function connected(content: Record<string, unknown>[], keyFor?: (id: string) => unknown) {
    const order: string[] = [];
    const client = new BaileysClient('/tmp/structured-send-test', 'key');
    (client as any).ready = true;
    (client as any).sock = {
      sendMessage: async (jid: string, message: unknown, options: { messageId?: string }) => {
        order.push('relayed');
        content.push({ jid, message, options });
        return { key: keyFor ? keyFor(options!.messageId!) : { id: options!.messageId } };
      },
    };
    (client as any).persistSentMessage = async () => {
      order.push('persisted');
    };
    return { client, order };
  }

  const pollContent: Record<string, unknown>[] = [];
  const pollSend = connected(pollContent);
  const pollId = await pollSend.client.sendPoll(
    { token: 't', conversationId: '111@c.us', name: 'Comida?', values: ['Pizza', 'Sushi'] },
    STABLE_ID,
    async () => {
      pollSend.order.push('claimed');
    }
  );
  assert.equal(pollId, STABLE_ID);
  assert.deepEqual(pollSend.order, ['claimed', 'relayed', 'persisted']);
  assert.equal((pollContent[0] as any).jid, '111@s.whatsapp.net');
  assert.equal((pollContent[0] as any).options.messageId, STABLE_ID);
  assert.deepEqual((pollContent[0] as any).message.poll.values, ['Pizza', 'Sushi']);

  const eventContent: Record<string, unknown>[] = [];
  const eventSend = connected(eventContent);
  const eventId = await eventSend.client.sendEvent(
    {
      token: 't',
      conversationId: '123@g.us',
      name: 'Cena',
      startDate: '2026-09-28T16:00:00.000Z',
      endDate: '2026-09-28T18:00:00.000Z',
      location: { name: 'Bar Luna' },
    },
    STABLE_ID,
    async () => {
      eventSend.order.push('claimed');
    }
  );
  assert.equal(eventId, STABLE_ID);
  assert.deepEqual(eventSend.order, ['claimed', 'relayed', 'persisted']);
  const event = (eventContent[0] as any).message.event;
  assert.equal(event.name, 'Cena');
  assert.equal(event.startDate.toISOString(), '2026-09-28T16:00:00.000Z');
  assert.deepEqual(event.location, { name: 'Bar Luna' });

  // What rc13 actually puts on the wire for that payload: a name, no coordinates.
  const prepared = await generateWAMessageContent(
    {
      event: {
        name: event.name,
        startDate: event.startDate,
        endDate: event.endDate,
        location: event.location,
      },
    },
    { upload: async () => Promise.reject(new Error('structured sends carry no media')) }
  );
  const encoded = proto.Message.encode(prepared).finish();
  const wire = proto.Message.decode(encoded).eventMessage!;
  assert.equal(wire.name, 'Cena');
  assert.equal(String(wire.startTime), String(Math.floor(event.startDate.getTime() / 1000)));
  assert.equal(String(wire.endTime), String(Math.floor(event.endDate.getTime() / 1000)));
  // Own properties only: a protobuf class carries its defaults on the
  // prototype, so a padded 0/0 pair has to show up as a key on the instance.
  assert.deepEqual(Object.keys(wire.location!), ['name']);
  assert.deepEqual(
    Buffer.from(proto.Message.LocationMessage.encode(wire.location!).finish()),
    Buffer.from(proto.Message.LocationMessage.encode({ name: 'Bar Luna' }).finish()),
    'the bytes must be exactly a name-only location'
  );

  for (const [kind, code] of [
    ['poll', 'POLL_SEND_OUTCOME_UNCERTAIN'],
    ['event', 'EVENT_CREATE_OUTCOME_UNCERTAIN'],
  ] as const) {
    for (const key of [() => undefined, () => ({}), () => ({ id: '3EB0SOMETHINGELSE00000' })]) {
      const odd: Record<string, unknown>[] = [];
      const oddSend = connected(odd, key);
      const send =
        kind === 'poll'
          ? oddSend.client.sendPoll(POLL, STABLE_ID, async () => {
              oddSend.order.push('claimed');
            })
          : oddSend.client.sendEvent(EVENT, STABLE_ID, async () => {
              oddSend.order.push('claimed');
            });
      await assert.rejects(send, structuredError(code, 409));
      assert.deepEqual(oddSend.order, ['claimed', 'relayed'], 'an unconfirmed id is not persisted');
    }
  }

  const hostile: Record<string, unknown>[] = [];
  const persistFails = connected(hostile);
  (persistFails.client as any).persistSentMessage = async () => {
    persistFails.order.push('persist-attempted');
    throw new Error('database unavailable');
  };
  assert.equal(
    await persistFails.client.sendPoll(POLL, STABLE_ID, async () => undefined),
    STABLE_ID,
    'a relayed poll stays accepted when local storage is behind'
  );
  assert.deepEqual(persistFails.order, ['relayed', 'persist-attempted']);

  const offline = new BaileysClient('/tmp/structured-send-test', 'key');
  let claimedWhileOffline = false;
  await assert.rejects(
    offline.sendPoll(POLL, STABLE_ID, async () => {
      claimedWhileOffline = true;
    }),
    structuredError('POLL_DISCONNECTED', 503)
  );
  await assert.rejects(
    offline.sendEvent(EVENT, STABLE_ID, async () => {
      claimedWhileOffline = true;
    }),
    structuredError('EVENT_CREATE_DISCONNECTED', 503)
  );
  assert.equal(claimedWhileOffline, false, 'a session that cannot relay must not burn the token');
});
