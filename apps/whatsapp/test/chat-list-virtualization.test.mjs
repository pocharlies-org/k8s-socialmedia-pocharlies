import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// #83 (QA velocidad): con 1000+ chats se montaban las 1033 filas enteras (p90 10,8 s).
// La lista se pinta ahora en ventana por scrollTop; el test fija el contrato interno.
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('#83: la ventana usa la altura fija de fila y buffer, con ruta completa por debajo del umbral', () => {
  assert.match(app, /const CHAT_ROW_H = 76;/, 'altura fija = .chat-item de styles.css');
  assert.match(app, /const CHAT_VIRTUAL_MIN = 80;/);
  assert.match(app, /chats\.length > CHAT_VIRTUAL_MIN/, 'por debajo del umbral se pinta todo (sin regresión)');
  assert.match(app, /chatWindowRange\(total, scrollTop, viewport\)/);
  assert.match(app, /chatSpacer\(\(virtualChats\.length - end\) \* CHAT_ROW_H\)/, 'espaciador inferior = altura que faltan');
});

test('#83: el scroll re-ventana con rAF y la vista «Destacados» desactiva la ventana', () => {
  assert.match(app, /\$\('chats'\)\.addEventListener\('scroll'/);
  assert.match(app, /requestAnimationFrame\(\(\) => \{/);
  assert.match(app, /starred'\) \{ virtualChats = null; virtualRange = null;/,
    'sin esto el scroll pintaría chats sobre la vista de mensajes destacados');
});

test('#83: la fila se construye en una función reutilizada por la ventana y el pintado completo', () => {
  assert.match(app, /function chatRowNode\(chat\)/);
  assert.match(app, /for \(const chat of virtualChats\.slice\(start, end\)\) list\.append\(chatRowNode\(chat\)\);/);
  assert.match(app, /for \(const chat of chats\) \$\('chats'\)\.append\(chatRowNode\(chat\)\);/);
});
