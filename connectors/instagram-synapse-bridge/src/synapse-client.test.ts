import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import { signInstagramPayload, SynapseClient } from './synapse-client';

const logger = pino({ enabled: false });

test('signs and sends the original raw bytes exactly once', async () => {
  const raw = Buffer.from('{"account":"skirmshop","text":"opaque"}', 'utf8');
  let seenBody: Uint8Array | undefined;
  let seenSignature = '';
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    seenBody = new Uint8Array(init?.body as Buffer);
    seenSignature = new Headers(init?.headers).get('X-Synapse-Instagram-Hmac-Sha256') || '';
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const client = new SynapseClient({
    url: 'https://synapse.e-dani.com/webhooks/instagram',
    secret: 'unit-secret',
    logger,
    fetchImpl,
  });
  assert.equal(await client.forward(raw), 'delivered');
  assert.deepEqual(Buffer.from(seenBody || []), raw);
  assert.equal(seenSignature, signInstagramPayload(raw, 'unit-secret'));
});

test('keeps every receiver rejection retryable during rollout and secret rotation', async () => {
  const statusClient = (status: number) =>
    new SynapseClient({
      url: 'https://synapse.e-dani.com/webhooks/instagram',
      secret: 'unit-secret',
      logger,
      fetchImpl: (async () => new Response(null, { status })) as typeof fetch,
    });
  assert.equal(await statusClient(503).forward(new Uint8Array()), 'retryable');
  assert.equal(await statusClient(429).forward(new Uint8Array()), 'retryable');
  assert.equal(await statusClient(401).forward(new Uint8Array()), 'retryable');
  assert.equal(await statusClient(404).forward(new Uint8Array()), 'retryable');
  assert.equal(await statusClient(422).forward(new Uint8Array()), 'retryable');
});
