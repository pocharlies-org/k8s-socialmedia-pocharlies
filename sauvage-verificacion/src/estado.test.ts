import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditadosHoy, cargarEstado, guardarVeredicto, type EstadoDb } from './estado';

// C6: la pasada arranca cargando el estado previo y lo dice con esta linea.
test('cargarEstado loggea `estado cargado: N veredictos previos`', async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    const db: EstadoDb = { query: async () => ({ rows: [{ n: 347 }] }) };
    const n = await cargarEstado(db);
    assert.equal(n, 347);
  } finally {
    console.log = original;
  }
  assert.deepEqual(logs, ['estado cargado: 347 veredictos previos']);
});

test('auditadosHoy devuelve el conjunto de ids del dia (reanudacion tras pod matado)', async () => {
  let sqlVista = '';
  const db: EstadoDb = {
    query: async (sql, params) => {
      sqlVista = sql;
      assert.deepEqual(params, ['professional']);
      return { rows: [{ user_id: '10' }, { user_id: '20' }] };
    },
  };
  const hoy = await auditadosHoy(db, 'professional');
  assert.deepEqual([...hoy], ['10', '20']);
  assert.match(sqlVista, /date_trunc\('day', now\(\)\)/);
});

test('guardarVeredicto escribe cuenta, miembro, veredicto y texto bruto', async () => {
  let sqlVista = '';
  let paramsVistas: unknown[] = [];
  const db: EstadoDb = {
    query: async (sql, params) => {
      sqlVista = sql;
      paramsVistas = params ?? [];
      return { rows: [] };
    },
  };
  await guardarVeredicto(db, {
    account: 'professional',
    userId: '42',
    verdict: 'no_auditar',
    rawText: 'vision_http_504 :: Gateway Timeout',
  });
  assert.match(sqlVista, /INSERT INTO savage_verdicts/);
  assert.deepEqual(paramsVistas, ['professional', '42', 'no_auditar', 'vision_http_504 :: Gateway Timeout']);
});
