/**
 * SC-1229 (SC-1197 P4b) — the internal HTTP surface of telegram-pairing:
 * flag, HMAC, store gate, limits/password errors → status codes. Real
 * TelegramSessionPool over the fake client; real express on an ephemeral
 * port; requests signed with shared's generateHMACSignature (what social-api
 * uses). Plus the two env pins of the spec: the config reads exactly the
 * approved variables, and NO source of this pool reads the house
 * TELEGRAM_SESSION_STRING*.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import {
  INTERNAL_TELEGRAM_SESSIONS_BASE,
  TelegramPairingAppOptions,
  createTelegramPairingApp,
  pairingApiEnabledFromEnv,
  pairingStoreAvailable,
  telegramPairingConfigFromEnv,
} from './app';
import { TelegramSessionPool } from './session-pool';
import { Clock, FakeTelegramFactory, MemoryStore } from './test-fakes';

const SECRET = 'test-connector-secret';
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const INVENTED = 'ffffffff-9999-4999-8999-ffffffffffff';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

async function serve(overrides: Partial<TelegramPairingAppOptions> = {}) {
  const factory = new FakeTelegramFactory();
  const store = new MemoryStore();
  const clock = new Clock(Date.now());
  const pool = new TelegramSessionPool({
    store,
    createClient: factory.create,
    now: clock.now,
    log: () => {},
  });
  const app = createTelegramPairingApp({
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

/** fetch().json() is `unknown`; test bodies read answers as plain records. */
async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

test('flag off → todo 404 salvo /health', async () => {
  const { base, close } = await serve({ apiEnabled: false });
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await json(health)).pairingApi, 'off');
    for (const path of ['/start', '/state', '/me', '/password']) {
      const r = await fetch(
        `${base}${INTERNAL_TELEGRAM_SESSIONS_BASE}${path}`,
        signed({ sessionKey: A })
      );
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: 'not_found' });
    }
    assert.equal((await fetch(`${base}/api/v1/status`)).status, 404);
  } finally {
    await close();
  }
});

test('sin firma HMAC válida → 401 (sin cabeceras, secreto ajeno, cuerpo alterado)', async () => {
  const { base, close, factory } = await serve();
  try {
    const url = `${base}${INTERNAL_TELEGRAM_SESSIONS_BASE}/start`;
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

test('firma correcta pero de hace 301 s → 401 (la ventana de 5 min la pone shared)', async () => {
  const { base, close, factory } = await serve();
  try {
    const url = `${base}${INTERNAL_TELEGRAM_SESSIONS_BASE}/start`;
    const oldTs = Math.floor(Date.now() / 1000) - 301;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(oldTs),
        'x-connector-signature': generateHMACSignature({ sessionKey: A }, oldTs, SECRET),
      },
      body: JSON.stringify({ sessionKey: A }),
    });
    assert.equal(r.status, 401);
    assert.equal(factory.clients.length, 0);
  } finally {
    await close();
  }
});

test('store apagado → 503 pairing_unavailable (tras la firma)', async () => {
  const { base, close } = await serve({ storeAvailable: false, pool: null });
  try {
    for (const path of ['/start', '/state', '/me', '/password']) {
      const r = await fetch(
        `${base}${INTERNAL_TELEGRAM_SESSIONS_BASE}${path}`,
        signed({ sessionKey: A })
      );
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { error: 'pairing_unavailable' });
    }
    const r = await fetch(`${base}${INTERNAL_TELEGRAM_SESSIONS_BASE}/start`, { method: 'POST' });
    assert.equal(r.status, 401);
    assert.equal((await json(await fetch(`${base}/health`))).store, 'unavailable');
  } finally {
    await close();
  }
});

test('sin secreto compartido → 503 pairing_unavailable (no se puede verificar)', async () => {
  const { base, close } = await serve({ sharedSecret: null });
  try {
    const r = await fetch(
      `${base}${INTERNAL_TELEGRAM_SESSIONS_BASE}/start`,
      signed({ sessionKey: A })
    );
    assert.equal(r.status, 503);
  } finally {
    await close();
  }
});

test('rutas firmadas: start → state(qr) → me 404 → authorize → me 200 {id, username}', async () => {
  const { base, close, factory, store } = await serve();
  try {
    const url = (p: string) => `${base}${INTERNAL_TELEGRAM_SESSIONS_BASE}${p}`;
    const start = await fetch(url('/start'), signed({ sessionKey: A }));
    assert.equal(start.status, 200);
    assert.equal((await json(start)).state, 'starting');

    factory.last(A).emitQr('tg://confirm/AAA');
    const state = await json(await fetch(url('/state'), signed({ sessionKey: A })));
    assert.equal(state.state, 'qr');
    assert.equal(state.qr.value, 'tg://confirm/AAA');
    assert.ok(Date.parse(state.qr.expiresAt) > Date.now());

    // aislamiento: B no ve el flujo de A
    const other = await json(await fetch(url('/state'), signed({ sessionKey: B })));
    assert.equal(other.state, 'unpaired');
    assert.equal(other.qr, null);

    // me antes de autorizar: 404 not_paired, cero filas
    const me = await fetch(url('/me'), signed({ sessionKey: A }));
    assert.equal(me.status, 404);
    assert.deepEqual(await me.json(), { error: 'not_paired' });
    assert.equal(store.rowsFor(A, 'telegram'), 0);
    assert.equal(store.rowsFor(INVENTED, 'telegram'), 0);

    factory.last(A).authorize({ id: '123456789', username: 'ana_tg' });
    await settle();
    assert.equal(store.rowsFor(A, 'telegram'), 1);

    const paired = await fetch(url('/me'), signed({ sessionKey: A }));
    assert.equal(paired.status, 200);
    assert.deepEqual(await paired.json(), {
      sessionKey: A,
      me: { id: '123456789', username: 'ana_tg' },
    });
  } finally {
    await close();
  }
});

test('password: 409 fuera del estado password; 200 y flujo completo cuando se espera', async () => {
  const { base, close, factory } = await serve();
  try {
    const url = (p: string) => `${base}${INTERNAL_TELEGRAM_SESSIONS_BASE}${p}`;
    // nada en marcha → 409
    const early = await fetch(url('/password'), signed({ sessionKey: A, password: 'x' }));
    assert.equal(early.status, 409);
    assert.deepEqual(await early.json(), { error: 'password_not_requested' });

    await fetch(url('/start'), signed({ sessionKey: A }));
    const asked = factory.last(A).requestPassword();
    const r = await fetch(url('/password'), signed({ sessionKey: A, password: 'secreta' }));
    assert.equal(r.status, 200);
    assert.equal((await json(r)).state, 'password');
    assert.equal(await asked, 'secreta');

    // password ausente/vacía → 400 invalid_password
    const bad = await fetch(url('/password'), signed({ sessionKey: A }));
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_password' });
  } finally {
    await close();
  }
});

test('sessionKey ausente o malformado → 400 invalid_session_key; start repetido → 429', async () => {
  const { base, close } = await serve();
  try {
    const url = (p: string) => `${base}${INTERNAL_TELEGRAM_SESSIONS_BASE}${p}`;
    for (const body of [{}, { sessionKey: '../x' }, { sessionKey: 42 }]) {
      const r = await fetch(url('/state'), signed(body));
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { error: 'invalid_session_key' });
    }
    await fetch(url('/start'), signed({ sessionKey: A }));
    const again = await fetch(url('/start'), signed({ sessionKey: A }));
    assert.equal(again.status, 429);
    assert.equal(again.headers.get('retry-after'), '60');
    assert.deepEqual(await again.json(), {
      error: 'rate_limited',
      reason: 'start_interval',
      retryAfterSeconds: 60,
    });
  } finally {
    await close();
  }
});

test('config del entorno: solo las variables aprobadas; TELEGRAM_SESSION_STRING* NUNCA se leen', () => {
  assert.equal(pairingApiEnabledFromEnv({}), false);
  assert.equal(pairingApiEnabledFromEnv({ SOCIAL_PAIRING_API: 'on' }), true);
  assert.equal(pairingStoreAvailable({}), false);
  assert.equal(
    pairingStoreAvailable({
      CREDENTIAL_STORE_ENABLED: 'true',
      CREDENTIAL_STORE_MASTER_KEY: MASTER_KEY,
    }),
    true
  );

  const cfg = telegramPairingConfigFromEnv({
    SOCIAL_PAIRING_API: 'on',
    CREDENTIAL_STORE_ENABLED: 'true',
    CREDENTIAL_STORE_MASTER_KEY: MASTER_KEY,
    CONNECTOR_SHARED_SECRET: 's3creto',
    TELEGRAM_API_ID: '2345678',
    TELEGRAM_API_HASH: 'abc123hash',
    PORT: '3002',
    // las sesiones de la casa, presentes en el entorno del pod: NO deben aparecer
    TELEGRAM_SESSION_STRING: '1.casa-personal-secret',
    TELEGRAM_SESSION_STRING_PROFESSIONAL: '1.casa-profesional-secret',
    SESSION_ENCRYPTION_KEY: 'no-es-de-telegram',
  });
  assert.deepEqual(cfg, {
    apiEnabled: true,
    storeAvailable: true,
    sharedSecret: 's3creto',
    apiId: 2345678,
    apiHash: 'abc123hash',
    port: 3002,
  });
  const dump = JSON.stringify(cfg);
  assert.equal(dump.includes('casa-personal'), false);
  assert.equal(dump.includes('casa-profesional'), false);
  assert.equal(dump.includes('no-es-de-telegram'), false);

  // API_ID basura → 0 (el entrypoint no construye el pool → 503)
  assert.equal(telegramPairingConfigFromEnv({ TELEGRAM_API_ID: 'x7' }).apiId, 0);
});

test('fuente del pool: ningún fichero lee TELEGRAM_SESSION_STRING (fuera de comentarios)', () => {
  // el nombre puede aparecer en los comentarios (documentando la prohibición);
  // lo que no puede aparecer es en código: se strippean los comentarios y se
  // busca la variable sobre el resto.
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of ['main.ts', 'app.ts', 'client.ts', 'session-pool.ts']) {
    // el script `pnpm test` corre desde connectors/telegram (cwd estable)
    const text = readFileSync(join(process.cwd(), 'src/pairing', file), 'utf-8');
    assert.equal(
      stripComments(text).includes('TELEGRAM_SESSION_STRING'),
      false,
      `${file} must not read the house session strings`
    );
  }
});
