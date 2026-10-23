import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUTAS_CONECTOR, RUTAS_ENVIO } from './conectores';

// C3 (DGX-1235 B1 and B2, security condition 5): reading never marks anything
// as read, and the only path that sends is POST /envios. Static: it scans every
// non-test source file of the bridge and of the scaffolding it imports from
// shared (shared/src/bridge: MeCache calls the connector). The live
// unread_count check is qa's.
const DIRS = [__dirname, join(__dirname, '..', '..', '..', 'shared', 'src', 'bridge')];
const fuentes = DIRS.flatMap(dir => readdirSync(dir)
  .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map(f => ({ f, texto: readFileSync(join(dir, f), 'utf-8') })));

test('C3: no source file names a mark-as-read call', () => {
  assert.ok(fuentes.some(x => x.f === 'me-cache.ts') && fuentes.some(x => x.f === 'lectura.ts') && fuentes.some(x => x.f === 'envios.ts'));
  const prohibido = /\/messages\/read|markAsRead|markRead|readMessages|readHistory|mark-read|sendSeen|readReceipt/i;
  for (const { f, texto } of fuentes) {
    assert.doesNotMatch(texto, prohibido, f);
  }
});

test('C3: the connector routes in the code are exactly the closed lists: GET reads and POST sends', () => {
  assert.deepEqual([...RUTAS_CONECTOR].sort(), ['/api/public/history/', '/api/public/messages/', '/api/v1/me']);
  assert.deepEqual([...RUTAS_ENVIO].sort(), ['/api/v1/messages/', '/api/v1/messages/send']);
  for (const { f, texto } of fuentes) {
    for (const m of texto.matchAll(/\/api\/[A-Za-z0-9/_:-]*/g)) {
      assert.ok(RUTAS_CONECTOR.includes(m[0]) || RUTAS_ENVIO.includes(m[0]), `${f}: ${m[0]} is not in a closed list`);
    }
  }
});

test('C3: the only non-GET requests are the ingest POST to the core and the send POST to a connector', () => {
  const permitidos: Record<string, string> = { 'entrega.ts': 'POST', 'conectores.ts': 'POST' };
  for (const { f, texto } of fuentes) {
    for (const m of texto.matchAll(/method:\s*['"`](\w+)['"`]/g)) {
      if (m[1] === 'GET') continue;
      assert.equal(m[1], permitidos[f], `${f}: method ${m[1]}`);
    }
  }
  const entrega = fuentes.find(x => x.f === 'entrega.ts');
  assert.ok(entrega && entrega.texto.includes('/v2/mensajes/'));
});

test('C3: the send routes appear only in the connector client, and /envios only in its handler', () => {
  for (const { f, texto } of fuentes) {
    if (f !== 'conectores.ts') assert.doesNotMatch(texto, /\/api\/v1\/messages|sendMessage/, f);
    if (f !== 'envios.ts') assert.doesNotMatch(texto, /['"`]\/envios/, f);
  }
  const cliente = fuentes.find(x => x.f === 'conectores.ts')?.texto ?? '';
  // Each send method checks its route against RUTAS_ENVIO, as each read does against RUTAS_CONECTOR.
  assert.match(cliente, /RUTAS_ENVIO\.some/);
  assert.match(cliente, /RUTAS_CONECTOR\.some/);
});
