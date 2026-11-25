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
    query: async sql => ({ rows: sql.includes('savage_actions') ? [{ user_id: '7' }] : filas }),
  };
  const nombres = new Map([['2', 'Ana (ana)']]);
  const d = await reunirInforme(db, 'professional', nombres);
  assert.equal(d.total, 5);
  assert.deepEqual(d.incumplidores, ['Ana (ana)', '5']);
  // C4→C5: reingresos = confirmado=true de hoy en savage_actions (la lista de
  // participantes lo confirmo), no el retorno del add.
  assert.deepEqual(d.reingresos, ['7']);
  assert.deepEqual(d.pendientes, ['3']);
  assert.deepEqual(d.ambiguedades, ['4']);
});

// C3 (INFRA-1561): el informe hace visible el hueco — un candidato `sin_cara`
// dentro del grupo sin dm ni ban (los doce medidos el 24-11) sale en el
// recuento y en la lista de candidatos sin accion.
test('C3 (INFRA-1561): el informe lleva candidatos, avisados y expulsados y lista los candidatos sin accion', async () => {
  const db: EstadoDb = {
    query: async sql => {
      if (sql.includes('savage_actions')) {
        // reingresosHoy (con date_trunc): ninguno. accionesPorUsuario: el dm
        // medido del 6468280801 (23-11 06:20:21 UTC), sin ban detras.
        return sql.includes('date_trunc')
          ? { rows: [] }
          : {
              rows: [
                { user_id: '6468280801', action: 'dm', at: '2026-11-23T06:20:21Z', confirmed: false, motivo: null },
              ],
            };
      }
      // savage_verdicts (auditadosDesde y veredictosActuales comparten filas).
      return {
        rows: [
          { user_id: '721652387', verdict: 'sin_cara' },
          { user_id: '6468280801', verdict: 'sin_cara' },
          { user_id: '999', verdict: 'cara' },
        ],
      };
    },
  };
  // 721652387 y 6468280801 siguen dentro; 999 tambien (pero cumple).
  const d = await reunirInforme(db, 'professional', new Map(), new Set(['721652387', '6468280801', '999']));
  assert.equal(d.moderacion?.candidatos.length, 2, 'dos candidatos sin_cara dentro del grupo');
  assert.deepEqual(d.moderacion?.avisados, ['6468280801']);
  assert.deepEqual(d.moderacion?.expulsados, [], 'ningun expulsado: el hueco es el punto');
  assert.deepEqual(d.moderacion?.sinAccion, ['721652387'], 'el candidato sin ninguna accion es visible');
  const texto = construirInforme(d);
  assert.match(texto, /moderacion \(candidatos=2 avisados=1 expulsados=0\)/);
  assert.match(texto, /candidatos sin accion \(1\):\n {2}- 721652387/);
});

test('C3 (INFRA-1561): sin lista de participantes el apartado de moderacion se omite (no se inventa)', async () => {
  const db: EstadoDb = { query: async () => ({ rows: [] }) };
  const d = await reunirInforme(db, 'professional', new Map());
  assert.equal(d.moderacion, undefined);
  assert.ok(!construirInforme(d).includes('moderacion'));
});
