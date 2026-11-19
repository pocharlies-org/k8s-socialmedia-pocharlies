import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturarSesionDeSalida, leerSesionDeSalidaDelRun } from './sesion-opencode';
import {
  configBase,
  dbFalsa,
  ejecutarConLogsSilenciados,
  filasPasada,
} from './test-harness';

/**
 * INFRA-745 (2a vuelta, defecto de qa en nota-qa-c1-18nov.md de INFRA-125):
 * el resolvedor de almacenamiento (PR 492) escribe la fila con sesion_id NULL
 * en las tres pasadas reales y el bot loguea `pasada-sesion ses=desconocido`.
 *
 * Medido en el job real del CronJob (kubectl logs del 19-11) y reproducido
 * instalando opencode-ai@1.18.30: esa version NO guarda sesiones en
 * <XDG_DATA_HOME>/opencode/storage/session/<proyecto>/ses_*.json — guarda el
 * estado en SQLite (<XDG_DATA_HOME>/opencode/opencode.db) —, asi que el
 * resolvedor nunca encuentra nada en el entorno del job. En cambio la SALIDA
 * del propio `opencode run` SIEMPRE lleva el id (`message=created id=ses_...`,
 * `session.id=ses_...`) y opencode la graba ademas en
 * <XDG_DATA_HOME>/opencode/log/opencode.log. Esta es la fuente fiable: la
 * pasada captura de ahi y el almacenamiento queda solo como fallback.
 *
 * El id real NO es 'ses_' + 22: los dos medidos (job del 18-11 copiado por qa
 * y job del 19-11) son 'ses_' + 26. Los tests usan la forma literal real.
 */

/**
 * Salida de un falso `opencode run`, linea a linea como la del job real
 * (copiada del `kubectl logs` del CronJob del 19-11; el id es el literal que
 * qa copio del log del 18-11). `opencode run --print-logs` vuelca estas
 * lineas a stdout y opencode las graba ademas en <data>/opencode/log/opencode.log.
 */
function salidaFalsaDeOpencodeRun(sesId: string): string {
  return [
    `timestamp=2026-11-18T06:30:18.375Z level=INFO run=858a96ea message="creating instance" directory=/app/sauvage-verificacion`,
    `timestamp=2026-11-18T06:30:18.800Z level=INFO run=858a96ea message=created id=${sesId} slug=swift-mountain version=1.18.30 projectID=global directory=/app/sauvage-verificacion path=app/sauvage-verificacion workspaceID=undefined parentID=undefined title="New session - 2026-11-18T06:30:18.800Z" agent=undefined model=undefined metadata=undefined cost=0`,
    `timestamp=2026-11-18T06:30:19.404Z level=INFO run=858a96ea message=loop session.id=${sesId} step=0`,
    `timestamp=2026-11-18T06:31:07.221Z level=INFO run=858a96ea message=loop session.id=${sesId} step=1`,
  ].join('\n') + '\n';
}

/** Falso opencode.log: la salida del run tal como la graba opencode en disco. */
function logFalso(salida: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sauvage-oclog-'));
  const ruta = join(dir, 'opencode.log');
  writeFileSync(ruta, salida);
  return ruta;
}

function filaPasada(db: ReturnType<typeof dbFalsa>) {
  const filas = filasPasada(db);
  assert.equal(filas.length, 1, 'exactamente una fila de pasada por pasada');
  return filas[0];
}

// Id literal copiado del log real del job del 18-11 (nota-qa-c1-18nov.md):
// 'ses_' + 26. Si la captura truncara o hardcodeara un largo, este id no pasa.
const SES_REAL = 'ses_e12dd84e7ffeacjasU5QRKXUsF';

test('C1 (rojo sin el fix): la fila lleva el ses_ capturado de la salida del run', async () => {
  const db = dbFalsa();
  // ROJO medido contra el codigo del fix original (PR 492): el campo
  // opencodeLogFile no existia y el test se paso con un cast; la fila salio
  // ["professional",null] (salida guardada en la PR). Con la captura de la
  // salida del run, la fila lleva el id.
  const cfg = configBase({ opencodeLogFile: logFalso(salidaFalsaDeOpencodeRun(SES_REAL)) });
  await ejecutarConLogsSilenciados(cfg, db);

  const fila = filaPasada(db);
  assert.ok(
    fila.params.includes(SES_REAL),
    `la fila lleva el id de la salida del run (formato real, 26 chars), got ${JSON.stringify(fila.params)}`
  );
});

test('C1: sin salida del run ni almacenamiento la pasada sigue y deja su fila con sesion NULL', async () => {
  const db = dbFalsa();
  await ejecutarConLogsSilenciados(configBase(), db);

  const fila = filaPasada(db);
  assert.equal(fila.params[1], null, 'sesion_id NULL cuando ni la salida ni el almacenamiento dan un ses_');
});

test('C1: sin linea de sesion en la salida, la pasada cae al almacenamiento (fallback)', async () => {
  // Salida del run sin ninguna linea con ses_ (p. ej. log truncado): se usa el
  // resolvedor de almacenamiento, que si encuentra la sesion en el layout legacy.
  const dirSes = mkdtempSync(join(tmpdir(), 'sauvage-ses-'));
  const proyecto = join(dirSes, 'app-sauvage');
  mkdirSync(proyecto, { recursive: true });
  writeFileSync(join(proyecto, 'ses_LEGACY123456.json'), JSON.stringify({ id: 'ses_LEGACY123456' }));
  const db = dbFalsa();
  const cfg = configBase({
    opencodeLogFile: logFalso('timestamp=... level=INFO run=abc message=init\n'),
    sesionesOpencodeDir: dirSes,
  });
  await ejecutarConLogsSilenciados(cfg, db);

  const fila = filaPasada(db);
  assert.ok(
    fila.params.includes('ses_LEGACY123456'),
    `fallback al almacenamiento intacto, got ${JSON.stringify(fila.params)}`
  );
});

test('capturarSesionDeSalida: gana la linea message=created sobre session.id', () => {
  const salida =
    'timestamp=... message=loop session.id=ses_ANterior123456789012 step=0\n' +
    salidaFalsaDeOpencodeRun(SES_REAL);
  assert.equal(capturarSesionDeSalida(salida), SES_REAL);
});

test('capturarSesionDeSalida: sin created, vale session.id (el mas reciente)', () => {
  const salida =
    'timestamp=... message=loop session.id=ses_PRIMERA123456789012 step=0\n' +
    'timestamp=... message=loop session.id=ses_SEGUNDA123456789012 step=1\n';
  assert.equal(capturarSesionDeSalida(salida), 'ses_SEGUNDA123456789012');
});

test('capturarSesionDeSalida: salida sin ningun ses_ es null (sin lanzar)', () => {
  assert.equal(capturarSesionDeSalida('message=init\nmessage="all LSPs are disabled"\n'), null);
});

test('leerSesionDeSalidaDelRun: fichero inexistente es null (sin lanzar)', () => {
  assert.equal(leerSesionDeSalidaDelRun('/no/existe/opencode.log'), null);
});
