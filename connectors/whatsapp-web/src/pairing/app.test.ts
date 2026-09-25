/**
 * SC-1225 (SC-1197 P1a) — the internal HTTP surface of whatsapp-pairing:
 * flag, HMAC, store gate, limits → status codes. Real SessionPool over the
 * fake socket; real express app on an ephemeral port; requests signed with
 * the connector's own generateHMACSignature (what social-api will use).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateHMACSignature } from '../api/auth';
import {
  INTERNAL_SESSIONS_BASE,
  PairingAppOptions,
  createPairingApp,
  pairingApiEnabledFromEnv,
  pairingStoreAvailable,
} from './app';
import { SessionPool } from './session-pool';
import { Clock, FakeFactory, MemoryStore } from './test-fakes';

const SECRET = 'test-connector-secret';
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

async function serve(overrides: Partial<PairingAppOptions> = {}) {
  const factory = new FakeFactory();
  const store = new MemoryStore();
  const clock = new Clock(Date.now());
  const pool = new SessionPool({
    store,
    sessionRoot: await mkdtemp(join(tmpdir(), 'pairing-app-')),
    createClient: factory.create,
    now: clock.now,
    log: () => {},
    debounceMs: 0,
  });
  const app = createPairingApp({
    apiEnabled: true,
    storeAvailable: true,
    sharedSecret: SECRET,
    pool,
    logError: () => {},
    ...overrides,
  });
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return { base, close, factory, store, pool };
}

function signed(body: unknown, secret = SECRET): RequestInit {
  const ts = Math.floor(Date.now() / 1000);
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-connector-timestamp': String(ts),
      'x-connector-signature': generateHMACSignature(body, ts, secret),
    },
    body: JSON.stringify(body),
  };
}

test('flag off → todo 404 salvo /health', async () => {
  const { base, close } = await serve({ apiEnabled: false });
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).pairingApi, 'off');
    for (const path of ['/start', '/state', '/me']) {
      const r = await fetch(`${base}${INTERNAL_SESSIONS_BASE}${path}`, signed({ sessionKey: A }));
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: 'not_found' });
    }
    assert.equal((await fetch(`${base}/qr`)).status, 404);
    assert.equal((await fetch(`${base}/auth/qr`)).status, 404);
  } finally {
    await close();
  }
});

test('sin firma HMAC válida → 401 (sin cabeceras, firma de otro secreto, cuerpo alterado)', async () => {
  const { base, close, factory } = await serve();
  try {
    const url = `${base}${INTERNAL_SESSIONS_BASE}/start`;
    const bare = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionKey: A }),
    });
    assert.equal(bare.status, 401);

    assert.equal((await fetch(url, signed({ sessionKey: A }, 'other-secret'))).status, 401);

    // Signature for A, body swapped to B: the sessionKey is inside the signature.
    const forged = signed({ sessionKey: A });
    forged.body = JSON.stringify({ sessionKey: B });
    assert.equal((await fetch(url, forged)).status, 401);
    assert.equal(factory.clients.length, 0);
  } finally {
    await close();
  }
});

test('store apagado → 503 pairing_unavailable (tras la firma)', async () => {
  const { base, close } = await serve({ storeAvailable: false, pool: null });
  try {
    for (const path of ['/start', '/state', '/me']) {
      const r = await fetch(`${base}${INTERNAL_SESSIONS_BASE}${path}`, signed({ sessionKey: A }));
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { error: 'pairing_unavailable' });
    }
    // Unauthenticated callers learn nothing about the store: still 401.
    const r = await fetch(`${base}${INTERNAL_SESSIONS_BASE}/start`, { method: 'POST' });
    assert.equal(r.status, 401);
    assert.equal((await (await fetch(`${base}/health`)).json()).store, 'unavailable');
  } finally {
    await close();
  }
});

test('sin secreto compartido → 503 pairing_unavailable (no se puede verificar)', async () => {
  const { base, close } = await serve({ sharedSecret: null });
  try {
    const r = await fetch(`${base}${INTERNAL_SESSIONS_BASE}/start`, signed({ sessionKey: A }));
    assert.equal(r.status, 503);
  } finally {
    await close();
  }
});

test('ruta firmada: start → state con QR → segundo start 429 con Retry-After; me 404 hasta emparejar', async () => {
  const { base, close, factory } = await serve();
  try {
    const url = (p: string) => `${base}${INTERNAL_SESSIONS_BASE}${p}`;
    const start = await fetch(url('/start'), signed({ sessionKey: A }));
    assert.equal(start.status, 200);
    assert.equal((await start.json()).state, 'starting');

    factory.last(A).emitQr('2@ref');
    const state = await (await fetch(url('/state'), signed({ sessionKey: A }))).json();
    assert.equal(state.state, 'qr');
    assert.equal(state.qr.value, '2@ref');
    assert.ok(Date.parse(state.qr.expiresAt) > Date.now());

    const other = await (await fetch(url('/state'), signed({ sessionKey: B }))).json();
    assert.equal(other.state, 'unpaired');
    assert.equal(other.qr, null);

    const again = await fetch(url('/start'), signed({ sessionKey: A }));
    assert.equal(again.status, 429);
    assert.equal(again.headers.get('retry-after'), '60');
    assert.deepEqual(await again.json(), {
      error: 'rate_limited',
      reason: 'start_interval',
      retryAfterSeconds: 60,
    });

    const me = await fetch(url('/me'), signed({ sessionKey: A }));
    assert.equal(me.status, 404);
    assert.deepEqual(await me.json(), { error: 'not_paired' });

    await factory.last(A).open('34600111222:7@s.whatsapp.net', 'Ana');
    const paired = await fetch(url('/me'), signed({ sessionKey: A }));
    assert.equal(paired.status, 200);
    assert.deepEqual(await paired.json(), {
      sessionKey: A,
      me: {
        id: '34600111222:7@s.whatsapp.net',
        jid: '34600111222@s.whatsapp.net',
        phone: '+34600111222',
        name: 'Ana',
      },
    });
  } finally {
    await close();
  }
});

test('sessionKey ausente o malformado → 400 invalid_session_key', async () => {
  const { base, close } = await serve();
  try {
    for (const body of [{}, { sessionKey: '../x' }, { sessionKey: 42 }]) {
      const r = await fetch(`${base}${INTERNAL_SESSIONS_BASE}/state`, signed(body));
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { error: 'invalid_session_key' });
    }
  } finally {
    await close();
  }
});

test('banderas de entorno: SOCIAL_PAIRING_API off por defecto; store = flag + clave maestra válida', () => {
  assert.equal(pairingApiEnabledFromEnv({}), false);
  assert.equal(pairingApiEnabledFromEnv({ SOCIAL_PAIRING_API: 'off' }), false);
  assert.equal(pairingApiEnabledFromEnv({ SOCIAL_PAIRING_API: 'on' }), true);

  assert.equal(pairingStoreAvailable({}), false);
  assert.equal(pairingStoreAvailable({ CREDENTIAL_STORE_MASTER_KEY: MASTER_KEY }), false);
  assert.equal(pairingStoreAvailable({ CREDENTIAL_STORE_ENABLED: 'true' }), false);
  const errors = console.error;
  console.error = () => {};
  try {
    assert.equal(
      pairingStoreAvailable({
        CREDENTIAL_STORE_ENABLED: 'true',
        CREDENTIAL_STORE_MASTER_KEY: 'short',
      }),
      false
    );
  } finally {
    console.error = errors;
  }
  assert.equal(
    pairingStoreAvailable({
      CREDENTIAL_STORE_ENABLED: 'true',
      CREDENTIAL_STORE_MASTER_KEY: MASTER_KEY,
    }),
    true
  );
});
