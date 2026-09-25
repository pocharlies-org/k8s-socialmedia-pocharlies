/**
 * SC-1229 (SC-1197 P4b) — the per-sub mtcute pool, against an in-memory
 * store and a fake client (node:test, run by the connector's `pnpm test`).
 * One test per acceptance box of the SC-1229 spec, named after it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidSessionKeyError,
  NotAwaitingPasswordError,
  PoolLimitError,
  TelegramSessionPool,
} from './session-pool';
import { Clock, FakeTelegramClient, FakeTelegramFactory, MemoryStore } from './test-fakes';

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const INVENTED = 'ffffffff-9999-4999-8999-ffffffffffff';
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

function makePool(overrides: {
  store?: MemoryStore;
  factory?: FakeTelegramFactory;
  clock?: Clock;
  limits?: Record<string, number>;
} = {}) {
  const store = overrides.store ?? new MemoryStore();
  const factory = overrides.factory ?? new FakeTelegramFactory();
  const clock = overrides.clock ?? new Clock();
  const pool = new TelegramSessionPool({
    store,
    createClient: factory.create,
    now: clock.now,
    log: () => {},
    limits: overrides.limits,
  });
  return { pool, store, factory, clock };
}

function deadSessionError(): Error {
  return Object.assign(new Error('AUTH_KEY_UNREGISTERED'), {
    name: 'RpcError',
    text: 'AUTH_KEY_UNREGISTERED',
  });
}

test('A inicia SU flujo y recibe el paso de autorización (QR con caducidad)', async () => {
  const { pool, factory } = makePool();
  const status = await pool.start(A);
  assert.equal(status.state, 'starting');
  assert.equal(status.sessionKey, A);

  factory.last(A).emitQr('tg://confirm/AAA', 30_000);
  const qr = await pool.status(A);
  assert.equal(qr.state, 'qr');
  assert.equal(qr.qr?.value, 'tg://confirm/AAA');
  assert.ok(qr.qr?.dataUrl.startsWith('data:image/png;base64,'));
  assert.ok(Date.parse(qr.qr!.expiresAt) > Date.parse(qr.qr!.issuedAt));
});

test('A no ve el flujo de B: el estado de B es unpaired mientras A tiene QR', async () => {
  const { pool, factory } = makePool();
  await pool.start(A);
  factory.last(A).emitQr('tg://confirm/AAA');
  const bStatus = await pool.status(B);
  assert.equal(bStatus.state, 'unpaired');
  assert.equal(bStatus.qr, null);
  assert.equal(bStatus.me, null);
  // y el QR de A no aparece en ninguna lectura de B
  assert.equal(JSON.stringify(bStatus).includes('tg://confirm'), false);
});

test('tras autorización simulada hay 1 fila telegram para A y 0 para un sub inventado', async () => {
  const { pool, store, factory } = makePool();
  await pool.start(A);
  factory.last(A).emitQr();
  // un escaneo que no llega a autorizarse no deja fila
  assert.equal(store.rowsFor(A, 'telegram'), 0);

  factory.last(A).authorize();
  await settle();
  assert.equal(store.rowsFor(A, 'telegram'), 1);
  assert.equal(store.rowsFor(INVENTED, 'telegram'), 0);
  assert.equal(store.rowsFor(B, 'telegram'), 0);
  const row = store.rows.get(`${A}/telegram`)!;
  assert.equal((row.payload as { sessionString: string }).sessionString, '1.fake-export');

  const status = await pool.status(A);
  assert.equal(status.state, 'paired');
  assert.equal(status.me?.id, '123456789');
});

test('pool nuevo (reinicio): me sale de la fila sin reautorizar (carga perezosa, cero QR)', async () => {
  const store = new MemoryStore();
  const { pool: pool1, factory: factory1 } = makePool({ store });
  await pool1.start(A);
  factory1.last(A).authorize();
  await settle();

  // segundo proceso: pool y factory nuevos, misma fila; la sesión cargada
  // responde con la identidad de la cuenta emparejada
  const factory2 = new FakeTelegramFactory();
  factory2.loadMe = { id: '123456789', username: 'ana_tg' };
  const { pool: pool2 } = makePool({ store, factory: factory2 });
  const me = await pool2.me(A);
  assert.deepEqual(me, { id: '123456789', username: 'ana_tg' });
  assert.equal(factory2.authFlowsFor(A), 0, 'reinicio no debe pedir QR');
  assert.deepEqual(factory2.last(A).loadedSessions, ['1.fake-export']);
  // la fila sigue siendo una (y se refrescó con el export del load)
  assert.equal(store.rowsFor(A, 'telegram'), 1);
  // la identidad queda en caché: un segundo me no abre otra conexión
  await pool2.me(A);
  assert.equal(factory2.loadCallsFor(A), 1);
});

test('2FA pedido → submitPassword lo entrega y el flujo se completa', async () => {
  const { pool, store, factory } = makePool();
  await pool.start(A);
  factory.last(A).emitQr();
  factory.last(A).scanned();

  const asked = factory.last(A).requestPassword();
  const waiting = await pool.status(A);
  assert.equal(waiting.state, 'password');
  assert.equal(waiting.qr, null);

  const after = await pool.submitPassword(A, 'mi-clave-2fa');
  assert.equal(await asked, 'mi-clave-2fa');
  assert.equal(after.state, 'password'); // hasta que Telegram confirma

  factory.last(A).authorize();
  await settle();
  assert.equal(store.rowsFor(A, 'telegram'), 1);
  assert.equal((await pool.status(A)).state, 'paired');
});

test('password rechazado por Telegram → vuelve a pedirlo (submitPassword de nuevo funciona)', async () => {
  const { pool, store, factory } = makePool();
  await pool.start(A);
  const first = factory.last(A).requestPassword();
  await pool.submitPassword(A, 'mala');
  assert.equal(await first, 'mala');
  factory.last(A).rejectPassword();
  assert.equal((await pool.status(A)).state, 'password');

  const second = factory.last(A).requestPassword();
  await pool.submitPassword(A, 'buena');
  assert.equal(await second, 'buena');
  factory.last(A).authorize();
  await settle();
  assert.equal(store.rowsFor(A, 'telegram'), 1);
});

test('submitPassword sin flujo esperando → NotAwaitingPasswordError', async () => {
  const { pool } = makePool();
  await assert.rejects(() => pool.submitPassword(A, 'x'), NotAwaitingPasswordError);
  await pool.start(A);
  await assert.rejects(() => pool.submitPassword(A, 'x'), NotAwaitingPasswordError); // estado starting
});

test('topes: 1 arranque/60 s, 5 QR por arranque, 10/día por sub y 10 sesiones vivas', async () => {
  const { pool, factory, clock } = makePool();
  await pool.start(A);
  await assert.rejects(
    () => pool.start(A),
    (e: unknown) => e instanceof PoolLimitError && e.reason === 'start_interval'
  );

  // QR: el quinto se muestra, el sexto agota el arranque y cierra el flujo
  clock.advance(60_000);
  await pool.start(B);
  const clientB = factory.last(B);
  for (let i = 1; i <= 5; i++) clientB.emitQr(`tg://confirm/rot${i}`);
  assert.equal((await pool.status(B)).state, 'qr');
  clientB.emitQr('tg://confirm/rot6');
  await settle();
  assert.ok(clientB.disconnects >= 1);
  await assert.rejects(
    () => pool.status(B),
    (e: unknown) => e instanceof PoolLimitError && e.reason === 'qr_limit'
  );

  // diario: 10 arranques por sub
  const { pool: p2, clock: c2 } = makePool();
  for (let i = 0; i < 10; i++) {
    await p2.start(A);
    c2.advance(60_000);
  }
  await assert.rejects(
    () => p2.start(A),
    (e: unknown) => e instanceof PoolLimitError && e.reason === 'daily_starts'
  );

  // pool lleno: 10 sockets vivos, el undécimo sin nada que desalojar
  const { pool: p3 } = makePool();
  for (let i = 0; i < 10; i++) await p3.start(`subvivo${i}`);
  await assert.rejects(
    () => p3.start('overflowsub'),
    (e: unknown) => e instanceof PoolLimitError && e.reason === 'pool_full'
  );
});

test('sesión invalidada en el lazy-load: borra la fila, marca expired y cierra la conexión', async () => {
  const store = new MemoryStore();
  await store.put(A, 'telegram', { sessionString: '1.muerta' });
  let created: FakeTelegramClient | null = null;
  const pool = new TelegramSessionPool({
    store,
    createClient: sessionKey => {
      created = new FakeTelegramClient(sessionKey);
      created.loadError = deadSessionError();
      return created;
    },
    log: () => {},
  });
  const me = await pool.me(A);
  assert.equal(me, null);
  assert.equal(store.rowsFor(A, 'telegram'), 0, 'la fila muerta no sobrevive');
  assert.equal((await pool.status(A)).state, 'expired');
  assert.equal(created!.disconnects, 1, 'la conexión perezosa se cierra');
});

test('autorización fallida (no invalidación) deja el sub unpaired y cierra el socket', async () => {
  const { pool, store, factory } = makePool();
  await pool.start(A);
  const client = factory.last(A);
  client.failAuth(new Error('PHONE_NUMBER_BANNED'));
  await settle();
  assert.equal((await pool.status(A)).state, 'unpaired');
  assert.equal(store.rowsFor(A, 'telegram'), 0);
  assert.equal(client.disconnects, 1);
});

test('sessionKey malformado → InvalidSessionKeyError', async () => {
  const { pool } = makePool();
  for (const bad of ['', '../x', 'a'.repeat(80), 'sp ace']) {
    await assert.rejects(() => pool.start(bad), InvalidSessionKeyError);
    await assert.rejects(() => pool.status(bad), InvalidSessionKeyError);
    await assert.rejects(() => pool.me(bad), InvalidSessionKeyError);
  }
});

test('start de un sub ya emparejado y vivo devuelve su estado sin abrir otro flujo', async () => {
  const { pool, factory, clock } = makePool();
  await pool.start(A);
  factory.last(A).authorize();
  await settle();
  clock.advance(60_000);
  const status = await pool.start(A);
  assert.equal(status.state, 'paired');
  assert.equal(factory.authFlowsFor(A), 1);
});

test('evictIdle cierra sockets inactivos; la fila sigue respondiendo paired sin socket', async () => {
  const { pool, store, factory, clock } = makePool();
  await pool.start(A);
  factory.last(A).authorize();
  await settle();
  clock.advance(11 * 60_000);
  assert.equal(await pool.evictIdle(), 1);
  assert.equal(factory.last(A).disconnects, 1);
  const status = await pool.status(A);
  assert.equal(status.state, 'paired');
  // sin socket ni identidad en caché tras un reinicio, status responde paired con me null
  const factory2 = new FakeTelegramFactory();
  const { pool: pool2 } = makePool({ store, factory: factory2 });
  const cold = await pool2.status(A);
  assert.equal(cold.state, 'paired');
  assert.equal(cold.me, null);
  assert.equal(factory2.clients.length, 0, 'status nunca abre socket');
});
