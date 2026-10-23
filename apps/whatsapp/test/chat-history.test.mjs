import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {mergeMessages, mergeRecentMessages, pinnedFirst, shouldSubmitMessageKey, visibleOutgoingMessages} from '../public/chat-history.mjs';

const message = (id, minute, extra = {}) => ({id, timestamp: `2026-09-27T12:${String(minute).padStart(2, '0')}:00Z`, text: id, ...extra});

test('app entrypoint parses as the classic script loaded by index', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /<script\s+src="\/app\.js"\s+defer><\/script>/);
  assert.doesNotThrow(() => new vm.Script(app, {filename:'app.js'}));
});

test('pinned chats precede unpinned chats without changing their relative order', () => {
  const chats = [{id:'a'}, {id:'b', pinned:true}, {id:'c', pinned:false}, {id:'d', pinned:true}];
  assert.deepEqual(pinnedFirst(chats).map(chat => chat.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(chats.map(chat => chat.id), ['a', 'b', 'c', 'd']);
});

test('older page and latest polling page retain full ordered history and replace duplicate ids', () => {
  const current = [message('m3', 3), message('m4', 4)];
  const older = mergeMessages(current, [message('m1', 1), message('m2', 2), message('m3', 3)]);
  const refreshed = mergeMessages(older, [message('m3', 3, {text:'edited'}), message('m4', 4), message('m5', 5)]);
  assert.deepEqual(refreshed.map(item => item.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(refreshed[2].text, 'edited');
  assert.equal(older.length, 4);
});

test('recent polling removes deleted messages in its window but retains older pages', () => {
  const existing = [message('old', 0), message('kept', 3), message('deleted', 4)];
  const result = mergeRecentMessages(existing, [message('kept', 3), message('new', 5)]);
  assert.deepEqual(result.map(item => item.id), ['old', 'kept', 'new']);
});

test('an early provider echo replaces exactly one optimistic bubble', () => {
  const timestamp = '2026-09-27T12:05:00Z';
  const outgoing = [
    {id:'local-1', account:'alpha', text:'igual', timestamp, state:'sending', knownIds:new Set()},
    {id:'local-2', account:'alpha', text:'igual', timestamp, state:'sending', knownIds:new Set()},
  ];
  const echo = {id:'db-1', waMessageId:'wa-1', text:'igual', fromMe:true, timestamp};
  assert.deepEqual(visibleOutgoingMessages([echo], outgoing).map(item => item.id), ['local-2']);
  assert.deepEqual(visibleOutgoingMessages([echo, {...echo, id:'db-2', waMessageId:'wa-2'}], outgoing), []);
  assert.equal(visibleOutgoingMessages([echo], [{...outgoing[0], knownIds:new Set(['wa-1'])}]).length, 1);
  assert.equal(visibleOutgoingMessages([{...echo, fromMe:false}], [outgoing[0]]).length, 1);
  assert.equal(visibleOutgoingMessages([echo], [{...outgoing[0], state:'failed'}]).length, 1);
  assert.equal(visibleOutgoingMessages([echo], [{...outgoing[0], messageId:'wa-1', state:'confirmed'}]).length, 0);
});

test('composer Enter preference honors Shift, composition and keyboard shortcuts', () => {
  const key = overrides => ({key:'Enter', shiftKey:false, ctrlKey:false, metaKey:false, isComposing:false, ...overrides});
  assert.equal(shouldSubmitMessageKey(key(), true), true);
  assert.equal(shouldSubmitMessageKey(key(), false), false);
  assert.equal(shouldSubmitMessageKey(key({ctrlKey:true}), false), true);
  assert.equal(shouldSubmitMessageKey(key({metaKey:true}), false), true);
  assert.equal(shouldSubmitMessageKey(key({shiftKey:true}), true), false);
  assert.equal(shouldSubmitMessageKey(key({isComposing:true}), true), false);
  // QA 22-10: el caso coarse=true se fue con el parámetro (nadie lo pasaba; en móvil
  // enterKeyHint="send" manda: Enter SÍ envía).
});

test('hay botón «ir abajo» cuando el chat está lejos del final (QA 22-10)', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /aria-label', 'Ir al final del chat'/);
  assert.match(app, /scrollTo\(\{top: \$\('messages'\)\.scrollHeight, behavior: 'smooth'\}\)/);
  assert.match(app, /scrollBottom\.hidden = !state\.chat \|\| pane\.scrollHeight - pane\.scrollTop - pane\.clientHeight < 300/);
});

test('el favorito se marca en la fila y Favoritos vacío explica cómo marcarlo (QA 22-10)', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /featureUI\?\.isChatFavorite\?\.\(chat\)/);
  assert.match(app, /aria-label', 'Chat destacado'/);
  assert.match(app, /Aún no has destacado ningún chat\. Toca «⌄»/);
});

test('F5 restaura el chat abierto y volver a la lista lo olvida (QA 22-10 #162)', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /setItem\(`wa:lastChat:\$\{state\.account\}`, chat\.id\)/);
  assert.match(app, /removeItem\(`wa:lastChat:\$\{state\.account\}`\)/);
  assert.match(app, /restoreLastChat\(\); \} else \$\('chat-status'\)/);
});

test('el cambio de cuenta pinta la última lista conocida y revalida (QA velocidad 22-10)', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const remembered = chatCache\.get\(scope\)\?\.chats \|\| \[\]/);
  assert.match(app, /if \(previous\.length && state\.chatListScope !== scope\) \{/);
  assert.match(app, /chatCache\.set\(scope, \{chats\}\)/);
});

test('Enter en la fila abre el chat con el foco en el composer (QA #75)', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /selectChat\(chat, \{ focusComposer: event\?\.detail === 0 \}\)/);
  assert.match(src, /if \(focusComposer\) \$\('message'\)\.focus\(\)/);
});

test('el fallo al saltar a un mensaje recarga la ventana en vez de clavarse (QA #73)', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /\+\+state\.messageRequestToken;\s*\n\s*\$\('messages'\)\.replaceChildren/);
});
test('la pestaña avisa de los no leídos (QA #74)', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /document\.title = unreadTotal \? `\(\$\{unreadTotal > 99 \? '99\+' : unreadTotal\}\) WhatsApp` : 'WhatsApp'/);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<title>WhatsApp<\/title>/);
});

test('la fila de chat tiene acciones rápidas fijar/silenciar/archivar (UX 21.2)', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /chat-quick chat-quick-\$\{action\}/);
  assert.match(src, /featureUI\?\.quickChatAction\?\.\(chat, action\)/);
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-row:hover \.chat-quick/);
  assert.match(css, /@media \(hover: none\) \{ \.chat-quick \{ display: none; \}/);
});
test('el buscador del listado pliega tildes como el servidor (QA #87)', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(src.includes("value.toLocaleLowerCase().normalize('NFD').replace(/\\p{Diacritic}/gu, '')"));
  assert.ok(src.includes("foldSearch(`${chat.name || ''} ${chat.preview || ''}`).includes(search)"));
});
test('el composer corta antes del 400 de longitud y avisa (QA #60)', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /\$\('message'\)\.maxLength = 20000/);
  assert.match(src, /charCount\.id = 'char-count'; charCount\.hidden = true/);
  assert.match(src, /counter\.hidden = length < 19000; counter\.textContent = `\$\{length\}\/20000`/);
});
test('arrastrar ficheros se señala mientras dura el arrastre (QA #85)', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /dropZone\.classList\.add\('is-over'\)/);
  assert.match(src, /addEventListener\('dragleave', \(\) => dropZone\.classList\.remove\('is-over'\)\)/);
});
test('QA #82: el avatar 404 de un chat se cachea y no se vuelve a pedir', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const avatarFailures = new Set\(\)/);
  assert.match(app, /avatarFailures\.has\(key\) \? null : messageRenderer\?\.safeMessageUrl/);
  assert.match(app, /avatarFailures\.add\(key\)/);
});
test('F5 pinta los últimos mensajes conocidos y revalida (QA velocidad #98)', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const messageCacheKey = \(account, chat\) => `wa:msgs:\$\{account\}:\$\{chat\}`/);
  assert.match(app, /paintCachedMessages\(ctx\);\s*\n\s*const result = await api\(query\('\/api\/messages'/);
  assert.match(app, /localStorage\.setItem\(messageCacheKey\(ctx\.account, ctx\.chat\), JSON\.stringify\(messages\)\)/);
});

test('el outbox se ordena por timestamp y el texto decide su dirección (QA #113 extra, QA #111)', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\}\)\)\)\.sort\(compareMessages\)/);
  assert.match(app, /import\('\.\/chat-history\.mjs'\)\.then\(module => \{\n\s*\(\{mergeMessages, compareMessages/);
  const render = await readFile(new URL('../public/message-render.mjs', import.meta.url), 'utf8');
  assert.match(render, /textElement\.setAttribute\('dir', 'auto'\)/);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<textarea id="message"[^>]*dir="auto"/);
});

test('el tema se aplica al root y el theme-color le sigue (QA #108)', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /document\.body\.dataset\.theme = document\.documentElement\.dataset\.theme = theme/);
  assert.match(app, /meta\.content = theme === 'light' \? '#efeae2' : '#161717'/);
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /html\[data-theme="light"\],\s*\nbody\[data-theme="light"\] \{\n  color-scheme: light;/);
});
test('el buscador casa números contra el id del chat y ofrece chatear si nada (QA #125)', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(src.includes("const numeric = /^\\+?[\\d\\s]{5,}$/.test(term)"));
  assert.match(src, /numberMatches\(chat\)/);
  assert.match(src, /Chatear con \+\$\{digits\}/);
  assert.match(src, /featureUI\?\.openNewChat\?\.\('chat', digits\)/);
});

test('la fila silenciada lo dice en el aria-label y el submenú da 1 año (QA #101)', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /\? ' · Silenciado' : ''\}/);
  const features = await readFile(new URL('../public/features-ui.mjs', import.meta.url), 'utf8');
  assert.match(features, /\['1 año', \(\) => perform\('mute', \{ muted: true \}, \{ durationMs: 365 \* 24 \* 60 \* 60 \* 1000 \}\)\]/);
});
test('el fallo del micrófono traduce el motivo por err.name (QA #126)', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /NotFoundError: 'no hay ningún micrófono conectado\.'/);
  assert.match(src, /NotAllowedError: 'permiso denegado\.'/);
  assert.match(src, /NotReadableError: 'el micrófono está ocupado\.'/);
  assert.doesNotMatch(src, /No se pudo acceder al micrófono: \$\{err\.message\}/);
});

test('UX #58: re-ancla al fondo tras asentar el layout, cita a 1 línea y chat fijado role=img', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(app, /if \(first\) requestAnimationFrame\(\(\) => \{/);
  assert.match(app, /pin\.setAttribute\('role', 'img'\)/);
  assert.match(css, /\.message-reply-reference \.message-kind-label \{[^}]*text-overflow: ellipsis/);
});
