import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ejecutarPasada, type ConfigPasada } from './pasada';
import { resolverSesionOpencode } from './sesion-opencode';
import type { EstadoDb } from './estado';
import type { FetchFn } from './connector-client';

/**
 * INFRA-745 (qa, nota-qa-c1.md de INFRA-125): C1 exige «cada pasada en su
 * propia sesion de opencode», pero el id `ses_` solo vivia en los logs del pod
 * y savage-pod-reaper (SUCCEEDED_TTL_SECONDS=7200) los borra a las 2 h del
 * exito: C1 no era verificable retroactivamente.
 *
 * Fix: cada pasada deja UNA FILA en savage_pasadas (migracion 044) con el `ses_`
 * de su sesion y su fecha/hora. Estos tests lo exigen: con un almacenamiento
 * de opencode falso (el layout real: <dir>/<proyecto>/ses_<id>.json, medido en
 * opencode-ai 1.18.30) la pasada debe producir la fila con ese id; sin el fix,
 * cero filas.
 */

const GRUPO = '-1003365295248';
const ids = ['1000001', '1000002', '1000003'];

function fetchTelegram(): FetchFn {
  return async (url: string) => {
    if (url.includes('/photo')) {
      return { status: 404, text: async () => '{"error":"No photo"}' };
    }
    if (url.includes('/participants')) {
      const offset = parseInt(url.match(/offset=(\d+)/)?.[1] ?? '0', 10);
      const pagina = ids.slice(offset).map(id => ({
        id, firstName: `P${id}`, lastName: null, username: null, isBot: false,
      }));
      return { status: 200, text: async () => JSON.stringify({ participants: pagina, total: ids.length }) };
    }
    return { status: 404, text: async () => '{}' };
  };
}

/** BD falsa que graba cada query (sql + params) como la haria pg.Pool. */
function dbFalsa(): EstadoDb & { queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (sql.includes('count(*)')) return { rows: [{ n: 0 }] };
      return { rows: [] };
    },
  };
}

/** Almacenamiento de opencode falso: <dir>/<proyecto>/ses_<id>.json. */
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

function config(dirSesiones?: string): ConfigPasada {
  return {
    group: GRUPO,
    account: 'professional',
    connectorProUrl: 'http://connector.local:3002/api/v1',
    connectorSecret: 's3creto',
    litellmUrl: 'http://litellm.local:4000/v1/chat/completions',
    litellmKey: 'k',
    visionModel: 'm',
    promptVision: 'criterio de prueba',
    fotosDir: mkdtempSync(join(tmpdir(), 'sauvage-fotos-')),
    sesionesOpencodeDir: dirSesiones ?? join(mkdtempSync(join(tmpdir(), 'sauvage-vacio-')), 'no-existe'),
  };
}

async function ejecutarConLogsSilenciados(cfg: ConfigPasada, db: EstadoDb): Promise<void> {
  const logReal = console.log;
  console.log = () => {};
  try {
    await ejecutarPasada(cfg, db, fetchTelegram());
  } finally {
    console.log = logReal;
  }
}

function filasPasada(db: { queries: Array<{ sql: string; params: unknown[] }> }) {
  return db.queries.filter(q => /INSERT INTO savage_pasadas/.test(q.sql));
}

test('C1: la pasada deja una fila en savage_pasadas con el ses_ de su sesion', async () => {
  const db = dbFalsa();
  await ejecutarConLogsSilenciados(config(dirSesiones([{ id: 'ses_ROJO1234567890' }])), db);

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
  await ejecutarConLogsSilenciados(config(), db); // directorio inexistente

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
