import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construirInforme, reunirInforme, type ApartadosInforme } from './informe';
import type { EstadoDb } from './estado';

// C5: el texto del informe contiene los cuatro apartados con esos nombres.
test('el informe lleva los cuatro apartados con sus nombres exactos', () => {
  const d: ApartadosInforme = {
    total: 350,
    incumplidores: ['111', '222'],
    reingresos: [],
    pendientes: ['333'],
    ambiguedades: ['444'],
  };
  const texto = construirInforme(d);
  assert.match(texto, /^incumplidores \(2\):$/m);
  assert.match(texto, /^reingresos \(0\):$/m);
  assert.match(texto, /^pendientes \(1\):$/m);
  assert.match(texto, /^ambiguedades \(1\):$/m);
  assert.match(texto, /total=350/);
  assert.match(texto, /- 111/);
  // reingresos: cero hasta que exista la parte B (INFRA-746).
  assert.match(texto, /reingresos \(0\):\n {2}- \(ninguno\)/);
});

test('reunirInforme cuadra el total con los auditados de hoy y clasifica por veredicto', async () => {
  const filas = [
    { user_id: '1', verdict: 'cara' },
    { user_id: '2', verdict: 'sin_cara' },
    { user_id: '3', verdict: 'no_auditar' },
    { user_id: '4', verdict: 'dudoso' },
    { user_id: '5', verdict: 'sin_cara' },
  ];
  const db: EstadoDb = {
    query: async () => ({ rows: filas }),
  };
  const nombres = new Map([['2', 'Ana (ana)']]);
  const d = await reunirInforme(db, 'professional', nombres);
  assert.equal(d.total, 5);
  assert.deepEqual(d.incumplidores, ['Ana (ana)', '5']);
  assert.deepEqual(d.reingresos, []);
  assert.deepEqual(d.pendientes, ['3']);
  assert.deepEqual(d.ambiguedades, ['4']);
});
