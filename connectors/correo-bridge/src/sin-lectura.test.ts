import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUTAS_CONECTOR } from './conectores';

// C3 (DGX-1235 B1, security condition 5): reading never marks anything as
// read, and the bridge never sends (that is B2). Static: it scans every
// non-test source file. The live unread_count check is qa's.
const SRC = __dirname;
const fuentes = readdirSync(SRC)
  .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map(f => ({ f, texto: readFileSync(join(SRC, f), 'utf-8') }));

test('C3: no source file names a mark-as-read call', () => {
  assert.ok(fuentes.length >= 5);
  const prohibido = /\/messages\/read|markAsRead|markRead|readMessages|readHistory|mark-read|sendSeen|readReceipt/i;
  for (const { f, texto } of fuentes) {
    assert.doesNotMatch(texto, prohibido, f);
  }
});

test('C3: the connector routes in the code are exactly the closed list, all GET', () => {
  assert.deepEqual([...RUTAS_CONECTOR].sort(), ['/api/public/history/', '/api/public/messages/', '/api/v1/me']);
  for (const { f, texto } of fuentes) {
    for (const m of texto.matchAll(/\/api\/[A-Za-z0-9/_:-]*/g)) {
      assert.ok(RUTAS_CONECTOR.includes(m[0]), `${f}: ${m[0]} is not in the closed list`);
    }
  }
});

test('C3: the only non-GET request is the POST of the ingest to the core; nothing sends', () => {
  for (const { f, texto } of fuentes) {
    for (const m of texto.matchAll(/method:\s*['"`](\w+)['"`]/g)) {
      if (m[1] === 'GET') continue;
      assert.equal(f, 'entrega.ts', `${f}: method ${m[1]}`);
      assert.equal(m[1], 'POST');
    }
    assert.doesNotMatch(texto, /\/send\b|\/envios|sendMessage/, f);
  }
  const entrega = fuentes.find(x => x.f === 'entrega.ts');
  assert.ok(entrega && entrega.texto.includes('/v2/mensajes/'));
});
