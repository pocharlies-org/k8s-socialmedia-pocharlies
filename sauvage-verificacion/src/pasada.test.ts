import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ejecutarPasada, type ConfigPasada } from './pasada';
import type { EstadoDb } from './estado';
import type { FetchFn } from './connector-client';

/**
 * INFRA-745 (qa, 70-qa.md de INFRA-125): el barrido se topaba a la primera
 * pagina de Telegram. MTProto devuelve como maximo 200 participantes por
 * llamada (`channels.getParticipants`), y el bot pedia `?limit=1000` en una
 * sola peticion: con un grupo de ~346 auditaba solo los 200 primeros y
 * presentaba `total=200` como si el barrido fuera completo (C2 NO CUMPLE).
 *
 * Este test modela el comportamiento REAL de Telegram: una pagina de
 * participantes mide como maximo 200, y `offset` avanza. El barrido debe
 * recorrer TODAS las paginas (200 + 146 = 346) y la linea
 * `barrido total=346 auditados=... no_auditados=...` debe cuadrar.
 */

const GRUPO = '-1003365295248';
const TOTAL_REAL = 346;
const ids = Array.from({ length: TOTAL_REAL }, (_, i) => String(1_000_000 + i));

function participante(id: string) {
  return { id, firstName: `P${id}`, lastName: null, username: null, isBot: false };
}

/**
 * Conector falso con la semantica de Telegram: cada pagina de participantes
 * mide como maximo 200 (el tope por llamada de `channels.getParticipants`),
 * `offset` avanza y la respuesta lleva `total` (el `count` real). Sin `offset`
 * (la peticion del bot antes del arreglo) devuelve solo los 200 primeros.
 */
function fetchTelegram(llamadas: string[]): FetchFn {
  return async (url: string) => {
    llamadas.push(url);
    if (url.includes('/photo')) {
      // Sin foto visible para la cuenta: dudoso, sin llamada de vision (404).
      return { status: 404, text: async () => '{"error":"No photo"}' };
    }
    if (url.includes('/participants')) {
      const offset = parseInt(url.match(/offset=(\d+)/)?.[1] ?? '0', 10);
      const limit = parseInt(url.match(/limit=(\d+)/)?.[1] ?? '200', 10);
      const pagina = ids.slice(offset, offset + Math.min(limit, 200)).map(participante);
      return {
        status: 200,
        text: async () => JSON.stringify({ participants: pagina, total: TOTAL_REAL }),
      };
    }
    return { status: 404, text: async () => '{}' };
  };
}

function dbFalsa(): EstadoDb & { guardados: string[] } {
  const guardados: string[] = [];
  return {
    guardados,
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('count(*)')) return { rows: [{ n: 0 }] };
      if (sql.includes('DISTINCT user_id')) return { rows: [] }; // nadie auditado hoy
      guardados.push(String((params as unknown[])?.[1])); // INSERT de guardarVeredicto
      return { rows: [] };
    },
  };
}

function config(): ConfigPasada {
  return {
    group: GRUPO,
    account: 'professional',
    connectorProUrl: 'http://connector.local:3002/api/v1',
    connectorSecret: 's3creto',
    litellmUrl: 'http://litellm.local:4000/v1/chat/completions',
    litellmKey: 'k',
    visionModel: 'm',
    promptVision: 'criterio de prueba',
    fotosDir: mkdtempSync(join(tmpdir(), 'sauvage-test-')),
  };
}

test('barrido: recorre TODAS las paginas (200 + 146) y la linea barrido cuadra (C2)', async () => {
  const llamadas: string[] = [];
  const db = dbFalsa();
  const logs: string[] = [];
  const logReal = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  let resultado;
  try {
    resultado = await ejecutarPasada(config(), db, fetchTelegram(llamadas));
  } finally {
    console.log = logReal;
  }

  // El total del barrido es el grupo entero, no la primera pagina.
  assert.equal(resultado.total, TOTAL_REAL, 'total del barrido');
  assert.equal(resultado.auditados + resultado.noAuditados, TOTAL_REAL, 'auditados + no_auditados = total');

  const linea = logs.find(l => l.startsWith('barrido total='));
  assert.match(
    linea ?? '',
    /^barrido total=346 auditados=\d+ no_auditados=\d+$/,
    'la linea del log exigida por C2'
  );
  const m = linea?.match(/^barrido total=(\d+) auditados=(\d+) no_auditados=(\d+)$/);
  assert.ok(m && Number(m[1]) === Number(m[2]) + Number(m[3]), 'total = auditados + no_auditados');

  // Una linea `veredicto ID=` por identidad, las 346 distintas (C2).
  const veredictos = logs.filter(l => /^veredicto ID=/.test(l));
  assert.equal(veredictos.length, TOTAL_REAL, 'una linea veredicto por miembro');
  assert.equal(new Set(veredictos.map(l => l.match(/ID=(\S+)/)?.[1])).size, TOTAL_REAL, 'ids distintos');
  assert.deepEqual(
    [...new Set(db.guardados)].sort(),
    [...ids].sort(),
    'guardado un veredicto por identidad del grupo entero'
  );

  // Sin foto (404) todo es dudoso: auditado, nunca no_auditar (spec).
  assert.equal(resultado.auditados, TOTAL_REAL);
  assert.equal(resultado.noAuditados, 0);
});

test('barrido: pide paginas hasta la corta y no una sola peticion de 1000', async () => {
  const llamadas: string[] = [];
  const db = dbFalsa();
  const logReal = console.log;
  console.log = () => {};
  try {
    await ejecutarPasada(config(), db, fetchTelegram(llamadas));
  } finally {
    console.log = logReal;
  }
  const peticiones = llamadas.filter(l => l.includes('/participants'));
  assert.equal(peticiones.length, 2, 'dos paginas: 200 + 146 (la corta termina el barrido)');
  assert.ok(peticiones[0].includes('offset=0'), 'primera pagina desde offset=0');
  assert.ok(peticiones[1].includes('offset=200'), 'segunda pagina desde offset=200');
});
