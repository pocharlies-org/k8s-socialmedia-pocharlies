import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regla dura del veredicto del architect (INFRA-125): el bot NO abre clientes
 * MTProto — la sesion es propiedad del proceso del conector y el bot habla con
 * Telegram solo por sus rutas HTTP. Este test es el grep que exige CI: recorre
 * todo el codigo del paquete (este fichero excluido, que nombra los patrones)
 * y falla si aparece la creacion de un cliente o una ruta de moderacion.
 */

// Los literales de moderacion van ensamblados por concatenacion: el grep del
// spec sobre la rama entera no debe encontrar ni siquiera los patrones de
// este test (lo busca en todo el arbol, excluidos node_modules y dist).
const PROHIBIDOS = [
  '@mtcute',
  'mtcute',
  'gramjs',
  'telethon',
  'TelegramClient',
  'ban' + 'ChatMember',
  'unban' + 'ChatMember',
  'export' + 'ChatInvite',
  'add' + 'ChatMembers',
];

test('sauvage-verificacion/ no crea ningun cliente MTProto ni llama a rutas de moderacion', () => {
  const dir = __dirname;
  const ficheros = readdirSync(dir).filter(f => f.endsWith('.ts') && f !== 'sin-mtproto.test.ts');
  assert.ok(ficheros.length >= 5, `esperaba los scripts del bot en ${dir}`);
  for (const f of ficheros) {
    const texto = readFileSync(join(dir, f), 'utf8');
    for (const p of PROHIBIDOS) {
      assert.ok(!texto.includes(p), `${f} contiene el patron prohibido ${p}`);
    }
  }
});
