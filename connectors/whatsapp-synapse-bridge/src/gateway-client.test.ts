import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import pino from 'pino';
import { GatewayClient, signGatewayPayload } from './gateway-client';
import { EventType, MessageReceivedEvent } from '@mcp-socialmedia/shared';

const silent = pino({ level: 'silent' });
const SECRET = 'test-webhook-secret';
const URL = 'https://synapse.e-dani.com/webhooks/whatsapp';

function makeEvent(): MessageReceivedEvent {
  return {
    eventType: EventType.MESSAGE_RECEIVED,
    conversationId: '34699999999@c.us',
    waMessageId: 'WAMSG-42',
    waTimestamp: '2026-06-23T00:00:00.000Z',
    senderWaId: '34699999999@c.us',
    content: 'hola',
    messageType: 'TEXT',
    isForwarded: false,
    account: 'professional',
  };
}

const logCtx = { waMessageId: 'WAMSG-42', account: 'professional' };
const noSleep = (): Promise<void> => Promise.resolve();

test('signGatewayPayload: known base64 HMAC-SHA256 vector', () => {
  const bytes = Buffer.from('hello world', 'utf8');
  const expected = createHmac('sha256', SECRET).update(bytes).digest('base64');
  assert.equal(signGatewayPayload(bytes, SECRET), expected);
  // sanity: it is base64, not hex
  assert.match(signGatewayPayload(bytes, SECRET), /^[A-Za-z0-9+/]+=*$/);
});

test('forward signs the EXACT bytes that are sent (byte-identity)', async () => {
  let sentBody: Buffer | undefined;
  let sentSig: string | undefined;

  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sentBody = init?.body as Buffer;
    sentSig = (init?.headers as Record<string, string>)['X-Synapse-Whatsapp-Hmac-Sha256'];
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;

  const client = new GatewayClient({ url: URL, secret: SECRET, logger: silent, fetchImpl, sleep: noSleep });
  const event = makeEvent();
  const result = await client.forward(event, logCtx);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'delivered');
  assert.ok(Buffer.isBuffer(sentBody), 'body must be a Buffer (exact bytes)');

  // The signature must verify against the EXACT bytes that were sent.
  const recomputed = createHmac('sha256', SECRET).update(sentBody as Buffer).digest('base64');
  assert.equal(sentSig, recomputed, 'header signature must match HMAC over the sent bytes');

  // And those bytes must deserialize back to the original event (no mangling).
  assert.deepEqual(JSON.parse((sentBody as Buffer).toString('utf8')), event);
});

test('retries on 500 then succeeds (full budget, never drops transient)', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts++;
    if (attempts < 3) return { ok: false, status: 500 } as Response;
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;

  const client = new GatewayClient({
    url: URL,
    secret: SECRET,
    logger: silent,
    fetchImpl,
    sleep: noSleep,
    maxAttempts: 8,
  });
  const result = await client.forward(makeEvent(), logCtx);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'delivered');
  assert.equal(result.attempts, 3);
});

test('retries on network error then succeeds', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts++;
    if (attempts < 2) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;

  const client = new GatewayClient({ url: URL, secret: SECRET, logger: silent, fetchImpl, sleep: noSleep });
  const result = await client.forward(makeEvent(), logCtx);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test('401 is retried a BOUNDED number of times then dropped', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts++;
    return { ok: false, status: 401 } as Response;
  }) as unknown as typeof fetch;

  const client = new GatewayClient({
    url: URL,
    secret: SECRET,
    logger: silent,
    fetchImpl,
    sleep: noSleep,
    maxAuthAttempts: 3,
    maxAttempts: 8,
  });
  const result = await client.forward(makeEvent(), logCtx);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'dropped-auth');
  assert.equal(result.status, 401);
  // Bounded: stops at maxAuthAttempts, well under maxAttempts.
  assert.equal(attempts, 3);
});

test('non-retryable 4xx (400) dropped immediately', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts++;
    return { ok: false, status: 400 } as Response;
  }) as unknown as typeof fetch;

  const client = new GatewayClient({ url: URL, secret: SECRET, logger: silent, fetchImpl, sleep: noSleep });
  const result = await client.forward(makeEvent(), logCtx);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'dropped-bad-request');
  assert.equal(attempts, 1);
});

test('exhausts retry budget on persistent 500 (does NOT drop early)', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts++;
    return { ok: false, status: 503 } as Response;
  }) as unknown as typeof fetch;

  const client = new GatewayClient({
    url: URL,
    secret: SECRET,
    logger: silent,
    fetchImpl,
    sleep: noSleep,
    maxAttempts: 5,
  });
  const result = await client.forward(makeEvent(), logCtx);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'exhausted');
  assert.equal(attempts, 5);
});
