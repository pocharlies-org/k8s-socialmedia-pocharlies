import assert from 'node:assert/strict';
import test from 'node:test';
import { sendEventResponseOnce } from './event-send';
import { SendAlreadyClaimedError, type SendReservation } from './send-idempotency';

const input = {token: 'fixture-token', conversationId: '123@g.us', eventMessageId: 'event', attendance: 'going' as const, extraGuestCount: 0};
const reservation = async (): Promise<SendReservation> => ({state: 'prepared', messageId: 'stable-id'});

test('concurrent event replies claim once and replay a completed response without relay', async () => {
  let claimed = false;
  let sent = false;
  let deliveries = 0;
  const ports = {
    reserve: async (): Promise<SendReservation> => ({state: sent ? 'sent' : 'prepared', messageId: 'stable-id'}),
    claim: async () => { if (claimed) throw new SendAlreadyClaimedError(); claimed = true; },
    confirm: async () => {sent = true; return '2026-09-28T00:00:00.000Z';},
    send: async (_input: typeof input, id: string, beforeSend: () => Promise<void>) => {await beforeSend(); deliveries++; return id;},
  };
  const results = await Promise.allSettled([sendEventResponseOnce(input, ports), sendEventResponseOnce(input, ports)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(deliveries, 1);
  assert.equal((await sendEventResponseOnce(input, ports)).deduplicated, true);
  assert.equal(deliveries, 1);
});

test('pending or conflicting tokens never call the sender', async () => {
  for (const state of ['pending', 'conflict'] as const) {
    await assert.rejects(sendEventResponseOnce(input, {reserve: async () => ({state, messageId: 'stable-id'}), send: async () => {throw new Error('must not relay');}}), {status: 409});
  }
});

test('after claiming, transport or confirmation failures remain uncertain and cannot be replayed automatically', async () => {
  for (const confirmationFails of [false, true]) {
    await assert.rejects(sendEventResponseOnce(input, {
      reserve: reservation, claim: async () => {}, confirm: async () => {throw new Error('database failure');},
      send: async (_input, id, beforeSend) => {await beforeSend(); if (!confirmationFails) throw new Error('transport failure'); return id;},
    }), {code: 'EVENT_SEND_OUTCOME_UNCERTAIN', status: 409});
  }
});

test('invalid attendance or guests fails before reservation, and preparation failure does not claim', async () => {
  await assert.rejects(sendEventResponseOnce({...input, extraGuestCount: -1}, {reserve: async () => {throw new Error('must not reserve');}, send: async () => ''}), {status: 400});
  await assert.rejects(sendEventResponseOnce(input, {reserve: reservation,
    claim: async () => {throw new Error('must not claim');}, send: async () => {throw new Error('missing event key');}}), /missing event key/);
});
