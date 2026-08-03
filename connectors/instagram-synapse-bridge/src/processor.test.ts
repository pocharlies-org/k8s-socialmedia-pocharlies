import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyMetrics, processMessage } from './processor';
import { DeliveryOutcome } from './synapse-client';

function validEvent(): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      platform: 'instagram',
      account: 'skirmshop',
      eventType: 'dm',
      senderId: 'opaque-sender',
      conversationId: 'opaque-conversation',
      messageId: 'opaque-message',
      text: 'Need help',
      timestamp: '2026-08-02T12:00:00.000Z',
    })
  );
}

function message(data: Uint8Array) {
  const calls: string[] = [];
  return {
    message: {
      data,
      ack: () => calls.push('ack'),
      nak: (delay: number) => calls.push(`nak:${delay}`),
      term: (reason?: string) => calls.push(`term:${reason}`),
    },
    calls,
  };
}

async function processWith(outcome: DeliveryOutcome, data = validEvent()) {
  const fake = message(data);
  const metrics = emptyMetrics();
  const result = await processMessage(
    fake.message,
    { forward: async () => outcome },
    5_000,
    metrics
  );
  return { ...fake, metrics, result };
}

test('acknowledges only after a Synapse 2xx delivery', async () => {
  const result = await processWith('delivered');
  assert.equal(result.result, 'ack');
  assert.deepEqual(result.calls, ['ack']);
  assert.equal(result.metrics.delivered, 1);
});

test('naks retryable delivery failures for JetStream redelivery', async () => {
  const result = await processWith('retryable');
  assert.equal(result.result, 'nak');
  assert.deepEqual(result.calls, ['nak:5000']);
  assert.equal(result.metrics.retried, 1);
});

test('terms malformed, wrong-account, and terminally rejected events', async () => {
  const malformed = await processWith('delivered', Buffer.from('{not-json'));
  assert.deepEqual(malformed.calls, ['term:invalid-json']);
  const wrongAccount = await processWith(
    'delivered',
    Buffer.from(
      JSON.stringify({
        platform: 'instagram',
        account: 'other',
        eventType: 'dm',
        senderId: 'x',
        conversationId: 'x',
        messageId: 'x',
        timestamp: '2026-08-02T12:00:00.000Z',
      })
    )
  );
  assert.deepEqual(wrongAccount.calls, ['term:invalid-instagram-dm']);
  const rejected = await processWith('terminal');
  assert.deepEqual(rejected.calls, ['term:synapse-terminal-rejection']);
});
