import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolverSesionOpencode } from './sesion-opencode';
import {
  configBase,
  dbFalsa,
  ejecutarConLogsSilenciados,
  filasPasada,
} from './test-harness';

/**
 * INFRA-745 (qa, nota-qa-c1.md de INFRA-125): C1 exige «cada pasada en su
 * propia sesion de opencode», pero el id `ses_` solo vivia en los logs del pod
 * y savage-pod-reaper (SUCCEEDED_TTL_SECONDS=7200) los borra a las 2 h del
 * exito: C1 no era verificable retroactivamente.
 *
 * Fix: cada pasada deja UNA FILA en savage_pasadas (migracion 044) con el `ses_`
 * de su sesion y su fecha/hora. Estos tests lo exigen: con un almacenamiento
 * de opencode falso (<dir>/<proyecto>/ses_<id>.json) la pasada debe producir la
 * fila con ese id; sin el fix, cero filas.
 *
 * 2a vuelta (nota-qa-c1-18nov.md): ese layout de almacenamiento NO lo escribe
 * opencode-ai 1.18.30 (guarda sesiones en SQLite) — aqui sigue siendo el
 * fallback que estos tests afirman; la fuente principal es la salida del run
 * (ver sesion-salida.test.ts).
 */

/** Almacenamiento de opencode falso (layout legacy): <dir>/<proyecto>/ses_<id>.json. */
function dirSesiones(con: Array<{ id: string; edadMs?: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sauvage-ses-'));
  const proyecto = join(dir, 'app-sauvage');
  mkdirSync(proyecto, { recursive: true });
  for (const s of con) {
    const ruta = join(proyecto, `${s.id}.json`);
    writeFileSync(ruta, JSON.stringify({ id: s.id, title: 'pasada diaria' }));
    if (s.edadMs != null) {
      const viejo = new Date(Date.now() - s.edadMs);
      utimesSync(ruta, viejo, viejo);
    }
  }
  return dir;
}

test('C1: la pasada deja una fila en savage_pasadas con el ses_ de su sesion', async () => {
  const db = dbFalsa();
  await ejecutarConLogsSilenciados(configBase({ sesionesOpencodeDir: dirSesiones([{ id: 'ses_ROJO1234567890' }]) }), db);

  const filas = filasPasada(db);
  assert.equal(filas.length, 1, 'exactamente una fila de pasada por pasada');
  assert.ok(
    filas[0].params.includes('ses_ROJO1234567890'),
    `la fila lleva el id de sesion de opencode, got ${JSON.stringify(filas[0].params)}`
  );
  assert.ok(filas[0].params.includes('professional'), 'la fila lleva la cuenta');
});

test('C1: sin ses_ resoluble la pasada sigue y deja su fila con sesion NULL', async () => {
  const db = dbFalsa();
  await ejecutarConLogsSilenciados(configBase(), db); // fuentes inexistentes

  const filas = filasPasada(db);
  assert.equal(filas.length, 1, 'la pasada ocurrio: su fila existe');
  assert.equal(filas[0].params[1], null, 'sesion_id NULL cuando no hay ses_ resoluble');
});

test('resolverSesionOpencode: gana el ses_ mas reciente y solo cuenta ses_*.json', () => {
  const dir = dirSesiones([
    { id: 'ses_VIEJA1234567890', edadMs: 60_000 },
    { id: 'ses_NUEVA1234567890' },
  ]);
  writeFileSync(join(dir, 'app-sauvage', 'basura.json'), JSON.stringify({ id: 'no-es-sesion' }));
  assert.equal(resolverSesionOpencode(dir), 'ses_NUEVA1234567890');
  assert.equal(resolverSesionOpencode(join(dir, 'no-existe')), null, 'sin directorio: null, sin lanzar');
});
