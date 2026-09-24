/**
 * SC-1225 (SC-1197 P1a) — the per-sub baileys pool, against an in-memory
 * store and a fake socket (node:test, run by the connector's `pnpm test`).
 * One test per acceptance box of the SC-1225 spec, named after it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidSessionKeyError,
  PoolLimitError,
  SessionPool,
  pairingMeFromCreds,
} from './session-pool';
import { Clock, FakeFactory, MemoryStore } from './test-fakes';

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const INVENTED = 'ffffffff-9999-4999-8999-ffffffffffff';
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

async function makePool(
  store = new MemoryStore(),
  factory = new FakeFactory(),
  clock = new Clock(),
  limits = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'pairing-pool-'));
  const pool = new SessionPool({
    store,
    sessionRoot: root,
    createClient: factory.create,
    limits,
    now: clock.now,
    log: () => {},
    debounceMs: 0,
  });
  return { pool, store, factory, clock, root };
}

async function rejectsWith(p: Promise<unknown>, reason: string): Promise<PoolLimitError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof PoolLimitError, `expected PoolLimitError, got ${e}`);
    assert.equal(e.reason, reason);
    assert.ok(e.retryAfterSeconds >= 1);
    return e;
  }
  assert.fail(`expected PoolLimitError(${reason})`);
}

test('criterio 1a: iniciar sesión para sub A emite QR con caducidad', async () => {
  const { pool, factory, clock } = await makePool();
  const started = await pool.start(A);
  assert.equal(started.state, 'starting');
  assert.equal(factory.last(A).connects, 1);

  factory.last(A).emitQr('2@ref-one');
  const st = await pool.status(A);
  assert.equal(st.state, 'qr');
  assert.ok(st.qr);
  assert.equal(st.qr.value, '2@ref-one');
  assert.match(st.qr.dataUrl, /^data:image\/png;base64,/);
  assert.equal(Date.parse(st.qr.expiresAt) - Date.parse(st.qr.issuedAt), 20_000);
  assert.equal(Date.parse(st.qr.issuedAt), clock.t);

  clock.advance(20_001); // ref rotated by WhatsApp and not replaced yet → no stale QR served
  const stale = await pool.status(A);
  assert.equal(stale.state, 'qr');
  assert.equal(stale.qr, null);
});

test('criterio 1b: sub A no ve el QR/estado de sub B', async () => {
  const { pool, factory } = await makePool();
  await pool.start(A);
  factory.last(A).emitQr('2@secret-of-A');

  const b = await pool.status(B);
  assert.deepEqual(b, { sessionKey: B, state: 'unpaired', qr: null, me: null });
  assert.equal(JSON.stringify(b).includes('secret-of-A'), false);
  assert.equal(await pool.me(B), null);
  assert.equal(factory.clients.length, 1, 'reading B never opens a socket');
});

test('criterio 1c: sexto QR del arranque → 429 qr_limit y el socket se cierra', async () => {
  const { pool, factory } = await makePool();
  await pool.start(A);
  const sock = factory.last(A);
  for (let i = 1; i <= 5; i++) sock.emitQr(`2@ref-${i}`);
  assert.equal((await pool.status(A)).qr?.value, '2@ref-5');

  sock.emitQr('2@ref-6');
  await rejectsWith(pool.status(A), 'qr_limit');
  assert.equal(sock.disconnects, 1);
  assert.equal(pool.size(), 0);
});

test('criterio 1c: segundo arranque en <60 s → 429 start_interval con Retry-After', async () => {
  const { pool, clock } = await makePool();
  await pool.start(A);
  clock.advance(10_000);
  const e = await rejectsWith(pool.start(A), 'start_interval');
  assert.equal(e.retryAfterSeconds, 50);
  await pool.start(B); // the limit is per sub
  clock.advance(50_000);
  await pool.start(A); // 60 s later it is allowed again
});

test('tope diario: 10 arranques al día por sub, el 11.º → 429 daily_starts', async () => {
  const { pool, clock } = await makePool();
  for (let i = 0; i < 10; i++) {
    await pool.start(A);
    clock.advance(61_000);
  }
  await rejectsWith(pool.start(A), 'daily_starts');
  clock.advance(24 * 60 * 60_000);
  await pool.start(A);
});

test('tope de 10 sesiones vivas: la 11.ª → 429 pool_full; el desalojo por inactividad libera sitio', async () => {
  const { pool, clock } = await makePool();
  const subs = Array.from({ length: 11 }, (_, i) => `sub-${String(i).padStart(2, '0')}`);
  for (const s of subs.slice(0, 10)) await pool.start(s);
  assert.equal(pool.size(), 10);
  await rejectsWith(pool.start(subs[10]), 'pool_full');

  clock.advance(10 * 60_000 + 1);
  await pool.start(subs[10]); // idle sockets evicted on demand
  assert.equal(pool.size(), 1);
});

test('criterio 1d: tras connection open simulado hay exactamente 1 fila para A y 0 para un sub inventado', async () => {
  const { pool, store, factory } = await makePool();
  await pool.start(A);
  const sock = factory.last(A);
  sock.emitQr('2@ref');
  await sock.saveCredsBeforeOpen();
  await settle();
  assert.equal(store.rowsFor(A), 0, 'no row before the first open');

  await sock.open('34600111222:7@s.whatsapp.net', 'Ana');
  await settle();
  assert.equal(store.rowsFor(A), 1);
  assert.equal(store.rowsFor(INVENTED), 0);
  assert.equal(store.rows.size, 1);

  const st = await pool.status(A);
  assert.equal(st.state, 'paired');
  assert.equal(st.qr, null);
  assert.equal(st.me?.jid, '34600111222@s.whatsapp.net');
});

test('criterio 1e: reinicio del pool (instancia nueva) → me de A sale de la fila sin QR', async () => {
  const store = new MemoryStore();
  const first = await makePool(store);
  await first.pool.start(A);
  await first.factory.last(A).open('34600111222:7@s.whatsapp.net', 'Ana');
  await settle();
  await first.pool.close();

  const second = await makePool(store); // fresh process: empty memory, same store
  const me = await second.pool.me(A);
  assert.deepEqual(me, {
    id: '34600111222:7@s.whatsapp.net',
    jid: '34600111222@s.whatsapp.net',
    phone: '+34600111222',
    name: 'Ana',
  });
  const st = await second.pool.status(A);
  assert.equal(st.state, 'paired');
  assert.equal(st.qr, null);
  assert.equal(second.factory.clients.length, 0, 'no socket, no QR');
});

test('criterio 1f: loggedOut → fila borrada, estado expired', async () => {
  const { pool, store, factory } = await makePool();
  await pool.start(A);
  const sock = factory.last(A);
  await sock.open('34600111222:7@s.whatsapp.net');
  await settle();
  assert.equal(store.rowsFor(A), 1);

  await sock.loggedOut();
  await settle();
  assert.equal(store.rowsFor(A), 0);
  const st = await pool.status(A);
  assert.equal(st.state, 'expired');
  assert.equal(st.me, null);
  assert.equal(await pool.me(A), null);
  assert.ok(sock.disconnects >= 1, 'reconnect loop stopped');
  sock.emitQr('2@after-logout'); // baileys would reconnect and emit a QR for nobody
  assert.equal((await pool.status(A)).state, 'expired');
});

test('arranque con fila existente: la sesión se carga en el auth dir antes de connect()', async () => {
  const store = new MemoryStore();
  const first = await makePool(store);
  await first.pool.start(A);
  await first.factory.last(A).open('34600111222:7@s.whatsapp.net');
  await settle();
  await first.pool.close();

  const second = await makePool(store);
  await second.pool.start(A);
  const sock = second.factory.last(A);
  await sock.open('34600111222:7@s.whatsapp.net'); // reconnect with stored creds, no QR
  await settle();
  assert.equal((await second.pool.status(A)).state, 'paired');
  assert.equal(store.rowsFor(A), 1);
});

test('sessionKey malformado → InvalidSessionKeyError (nunca toca disco ni store)', async () => {
  const { pool, store, factory } = await makePool();
  await assert.rejects(pool.start('../../etc'), InvalidSessionKeyError);
  await assert.rejects(pool.status('a/b'), InvalidSessionKeyError);
  await assert.rejects(pool.me(''), InvalidSessionKeyError);
  assert.equal(store.gets, 0);
  assert.equal(factory.clients.length, 0);
});

test('pairingMeFromCreds: sin me → null; id con dispositivo → jid sin dispositivo', () => {
  assert.equal(pairingMeFromCreds({ noiseKey: 1 }), null);
  assert.equal(pairingMeFromCreds(null), null);
  assert.deepEqual(pairingMeFromCreds({ me: { id: '123abc@lid' } }), {
    id: '123abc@lid',
    jid: '123abc@lid',
    phone: null,
    name: null,
  });
});
