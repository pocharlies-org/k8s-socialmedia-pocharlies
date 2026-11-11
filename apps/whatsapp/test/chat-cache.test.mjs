import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Jordi 22-10 (criterio de Dani: sin pantallas de carga): la lista se pinta desde
// localStorage al abrir y el aviso «Cargando más conversaciones…» no existe.
test('la lista de chats se pinta desde la caché persistente y sin avisos de carga', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /const CHATS_CACHE_PREFIX = 'wa-chats-cache-v1:'/);
  assert.match(src, /rememberChats\(scope, chats\)/);
  assert.doesNotMatch(src, /Cargando más conversaciones…'\)/);
});
