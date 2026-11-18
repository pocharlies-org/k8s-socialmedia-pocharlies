import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// QA velocidad 1c: el service worker cache-first de los estáticos.
test('sw.js sirve estáticos stale-while-revalidate y no toca datos ni sesión', async () => {
  const sw = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new vm.Script(sw, { filename: 'sw.js' }));
  assert.match(sw, /stale-while-revalidate/i);
  // Solo GET same-origin de extensiones estáticas: /api, /auth y el HTML quedan fuera.
  assert.match(sw, /event\.request\.method !== 'GET' \|\| url\.origin !== self\.location\.origin \|\| !STATIC\.test/);
  assert.ok(sw.includes('js|mjs|css|woff2|svg|png|ico|webmanifest'));
  assert.ok(!sw.includes('/api/'), 'el service worker no debe mencionar rutas de datos');
  // Caché versionada y limpieza de las viejas, para que un despliegue no deje capas muertas.
  assert.match(sw, /names\.filter\(name => name !== CACHE\)\.map\(name => caches\.delete\(name\)\)/);
});

test('app.js registra el service worker sin romper sin soporte', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \('serviceWorker' in navigator\) navigator\.serviceWorker\.register\('\/sw\.js'\)\.catch\(\(\) => \{\}\)/);
});
