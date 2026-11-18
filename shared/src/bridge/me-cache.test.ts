import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import pino from 'pino';
import { MeCache } from './me-cache';

const SECRET = 'connector-shared-secret-test';
const silent = pino({ level: 'silent' });

function expectedSig(ts: number): string {
  // Connector signs `${ts}:${JSON.stringify(req.body)}` with req.body === {}.
  return 'sha256=' + createHmac('sha256', SECRET).update(`${ts}:{}`).digest('hex');
}

test('me-cache: GET /me carries NO body (fetch forbids GET+body) and signs over {}', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: unknown, init: unknown) => {
    captured = { url: String(url), init: init as RequestInit };
    return new Response(JSON.stringify({ id: '34628534490:5@c.us', name: 'X' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const cache = new MeCache({
    connectorUrl: 'http://connector:3001',
    connectorSharedSecret: SECRET,
    ttlMs: 60_000,
    logger: silent,
    fetchImpl,
    now: () => 1_700_000_000_000,
  });

  const jid = await cache.getOwnJid();
  assert.equal(jid, '34628534490:5@c.us');
  assert.ok(captured, 'fetch was called');
  const { url, init } = captured!;
  assert.equal(url, 'http://connector:3001/api/v1/me');
  assert.equal(init.method, 'GET');
  // The regression: a GET MUST NOT carry a body or undici throws at runtime.
  assert.equal((init as { body?: unknown }).body, undefined, 'GET must have no body');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers['X-Connector-Timestamp'], '1700000000');
  assert.equal(headers['X-Connector-Signature'], expectedSig(1_700_000_000));
  assert.equal(cache.isReady(), true);
});

test('me-cache: fail-closed (empty JID) on non-2xx with no prior value', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
  const cache = new MeCache({
    connectorUrl: 'http://connector:3001',
    connectorSharedSecret: SECRET,
    ttlMs: 60_000,
    logger: silent,
    fetchImpl,
  });
  assert.equal(await cache.getOwnJid(), '');
  assert.equal(cache.isReady(), false);
});

test('me-cache: fail-closed (empty JID) when fetch throws', async () => {
  const fetchImpl = (async () => {
    throw new Error('Request with GET/HEAD method cannot have body.');
  }) as unknown as typeof fetch;
  const cache = new MeCache({
    connectorUrl: 'http://connector:3001',
    connectorSharedSecret: SECRET,
    ttlMs: 60_000,
    logger: silent,
    fetchImpl,
  });
  assert.equal(await cache.getOwnJid(), '');
});
