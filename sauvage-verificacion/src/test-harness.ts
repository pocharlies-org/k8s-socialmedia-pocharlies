import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ejecutarPasada, type ConfigPasada } from './pasada';
import type { EstadoDb } from './estado';
import type { FetchFn } from './connector-client';

/**
 * Andamiaje compartido de los tests de la pasada (INFRA-745): lo usan
 * pasada.test.ts, pasada-sesion.test.ts y sesion-salida.test.ts (el detector
 * de duplicados pide reutilizar, no copiar).
 */

export const GRUPO = '-1003365295248';
export const ids = ['1000001', '1000002', '1000003'];

/**
 * Conector falso: participantes todos sin foto (404 => dudoso), con la
 * semantica REAL de Telegram en el paginador: cada pagina de participantes
 * mide como maximo 200 (el tope por llamada de `channels.getParticipants`),
 * `offset` avanza y la respuesta lleva `total`. Por defecto 3 participantes;
 * `ids` permite modelar un grupo mayor (pasada.test.ts modela 346) y
 * `llamadas` graba cada URL pedida, como hacia el falso local de ese test.
 */
export function fetchTelegram(opts: { ids?: string[]; llamadas?: string[] } = {}): FetchFn {
  const todos = opts.ids ?? ids;
  return async (url: string) => {
    opts.llamadas?.push(url);
    if (url.includes('/photo')) {
      return { status: 404, text: async () => '{"error":"No photo"}' };
    }
    if (url.includes('/participants')) {
      const offset = parseInt(url.match(/offset=(\d+)/)?.[1] ?? '0', 10);
      const limit = parseInt(url.match(/limit=(\d+)/)?.[1] ?? '200', 10);
      const pagina = todos.slice(offset, offset + Math.min(limit, 200)).map(id => ({
        id, firstName: `P${id}`, lastName: null, username: null, isBot: false,
      }));
      return { status: 200, text: async () => JSON.stringify({ participants: pagina, total: todos.length }) };
    }
    return { status: 404, text: async () => '{}' };
  };
}

/** BD falsa que graba cada query (sql + params) como la haria pg.Pool. */
export function dbFalsa(): EstadoDb & { queries: Array<{ sql: string; params: unknown[] }> } {
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

/**
 * Configuracion de pasada con fuentes de sesion INEXISTENTES por defecto (ni
 * salida del run ni almacenamiento): la fila sale con sesion NULL, salvo que
 * el test pase las suyas.
 */
export function configBase(
  overrides: { opencodeLogFile?: string; sesionesOpencodeDir?: string } = {}
): ConfigPasada {
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
    opencodeLogFile:
      overrides.opencodeLogFile ?? join(mkdtempSync(join(tmpdir(), 'sauvage-sinlog-')), 'no-existe.log'),
    sesionesOpencodeDir:
      overrides.sesionesOpencodeDir ?? join(mkdtempSync(join(tmpdir(), 'sauvage-vacio-')), 'no-existe'),
  };
}

/** Ejecuta la pasada sin ensuciar la salida TAP con sus logs. */
export async function ejecutarConLogsSilenciados(
  cfg: ConfigPasada,
  db: EstadoDb,
  fetch: FetchFn = fetchTelegram()
): Promise<void> {
  const logReal = console.log;
  console.log = () => {};
  try {
    await ejecutarPasada(cfg, db, fetch);
  } finally {
    console.log = logReal;
  }
}

/** Las filas INSERT INTO savage_pasadas grabadas por la BD falsa. */
export function filasPasada(db: { queries: Array<{ sql: string; params: unknown[] }> }) {
  return db.queries.filter(q => /INSERT INTO savage_pasadas/.test(q.sql));
}
