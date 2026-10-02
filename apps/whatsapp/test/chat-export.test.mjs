import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_EXPORT_LIMIT,
  ChatExportCanceled,
  ChatExportError,
  attachmentLines,
  buildExportFilename,
  buildMessagesUrl,
  collectMessages,
  createPageFetcher,
  exportConversationText,
  formatExportTimestamp,
  renderTranscript,
  senderLabel,
} from '../public/chat-export.mjs';

const ACCOUNT = 'personal';
const CHAT = '346001122@s.whatsapp.net';

function message(id, when, extra = {}) {
  return { id, text: `texto ${id}`, timestamp: new Date(when).toISOString(), fromMe: false, ...extra };
}

function fakeFetch(pages) {
  const byCursor = new Map([['start', pages[0]]]);
  for (let index = 1; index < pages.length; index += 1) byCursor.set(String(pages[index - 1].nextCursor), pages[index]);
  const calls = [];
  const fetchPage = async params => {
    calls.push(params);
    const page = byCursor.get(params.cursor === null ? 'start' : String(params.cursor));
    if (page === undefined) throw new Error(`página inesperada ${params.cursor}`);
    return typeof page === 'function' ? page(params) : page;
  };
  return { fetchPage, calls };
}

const queryOf = url => new URLSearchParams(url.split('?')[1] || '');

test('recorre todas las páginas con before como entrada de paginación y devuelve orden cronológico', async () => {
  const pages = [
    { messages: [message('c', 3000), message('b', 2000)], nextCursor: '1' },
    { messages: [message('d', 1500), message('a', 1000)], nextCursor: '2' },
    { messages: [message('e', 500)], nextCursor: null },
  ];
  const { fetchPage, calls } = fakeFetch(pages);
  const progress = [];
  const { messages, stats } = await collectMessages({ fetchPage, account: ACCOUNT, chat: CHAT, limit: 2, onProgress: p => progress.push(p) });
  assert.deepEqual(messages.map(m => m.id), ['e', 'a', 'd', 'b', 'c']);
  assert.deepEqual(stats, { pages: 3, exported: 5, duplicatesRemoved: 0 });
  assert.deepEqual(progress.at(-1), { pages: 3, messages: 5, duplicatesRemoved: 0 });
  assert.deepEqual(calls.map(c => c.cursor), [null, '1', '2']);
  const url = buildMessagesUrl({ account: ACCOUNT, chat: CHAT, cursor: 'x:9', limit: 2 });
  const query = queryOf(url);
  assert.equal(query.get('before'), 'x:9');
  assert.equal(query.get('limit'), '2');
  assert.equal(query.get('cursor'), null);
  assert.equal(queryOf(buildMessagesUrl({ account: ACCOUNT, chat: CHAT })).get('before'), null);
  assert.equal(queryOf(buildMessagesUrl({ account: ACCOUNT, chat: CHAT })).get('limit'), String(CHAT_EXPORT_LIMIT));
});

test('la cuenta y el chat quedan capturados al inicio aunque el llamante cambie de cuenta', async () => {
  const pages = [{ messages: [message('a', 1000)], nextCursor: '1' }, { messages: [message('b', 500)], nextCursor: null }];
  const { fetchPage, calls } = fakeFetch(pages);
  await collectMessages({ fetchPage, account: ACCOUNT, chat: CHAT });
  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual({ account: call.account, chat: call.chat }, { account: ACCOUNT, chat: CHAT });
});

test('deduplica historiales repetidos por id sin perder el primer mensaje', async () => {
  const shared = message('dup', 1000);
  const pages = [
    { messages: [message('b', 2000), shared], nextCursor: '1' },
    { messages: [shared, message('a', 500)], nextCursor: null },
  ];
  const { fetchPage } = fakeFetch(pages);
  const { messages, stats } = await collectMessages({ fetchPage, account: ACCOUNT, chat: CHAT });
  assert.deepEqual(messages.map(m => m.id), ['a', 'dup', 'b']);
  assert.equal(messages.find(m => m.id === 'dup').text, shared.text);
  assert.equal(stats.duplicatesRemoved, 1);
});

test('mensajes con el mismo timestamp tienen orden determinista por id', async () => {
  const pages = [{ messages: [message('z-9', 1000), message('a-1', 1000), message('m-5', 1000)], nextCursor: null }];
  const { fetchPage } = fakeFetch(pages);
  const { messages } = await collectMessages({ fetchPage, account: ACCOUNT, chat: CHAT });
  assert.deepEqual(messages.map(m => m.id), ['a-1', 'm-5', 'z-9']);
});

test('un cursor repetido detiene la exportación sin resultado parcial', async () => {
  const { fetchPage } = fakeFetch([
    { messages: [message('a', 1000)], nextCursor: 'same' },
    { messages: [message('b', 900)], nextCursor: 'same' },
  ]);
  await assert.rejects(
    collectMessages({ fetchPage, account: ACCOUNT, chat: CHAT, limit: 1 }),
    error => error instanceof ChatExportError && /cursor/i.test(error.message)
  );
});

test('respuestas malformadas se detectan, no se exportan a medias', async () => {
  const broken = [
    null,
    { nextCursor: null },
    { messages: 'no-es-lista', nextCursor: null },
    { messages: [{ text: 'sin id' }], nextCursor: null },
    { messages: [{ id: 'x', timestamp: 'no-es-fecha' }], nextCursor: null },
    { messages: [], nextCursor: 'siguiente' },
    { messages: [message('a', 1)], nextCursor: 42 },
    { messages: [message('a', 1)] },
    { messages: [message('a', 1)], nextCursor: '' },
  ];
  for (const page of broken) {
    const { fetchPage } = fakeFetch([page]);
    await assert.rejects(collectMessages({ fetchPage, account: ACCOUNT, chat: CHAT }), ChatExportError, `página ${JSON.stringify(page)}`);
  }
});

test('el error de red se propaga como ChatExportError con contexto y causa', async () => {
  const boom = new Error('boom');
  const { fetchPage } = fakeFetch([() => Promise.reject(boom)]);
  await assert.rejects(
    collectMessages({ fetchPage, account: ACCOUNT, chat: CHAT }),
    error => error instanceof ChatExportError && error.cause === boom && /página/.test(error.message)
  );
});

test('cancelar durante la última página no devuelve un resultado ya caducado', async () => {
  const controller = new AbortController();
  const { fetchPage } = fakeFetch([() => {
    controller.abort();
    return { messages: [message('a', 1000)], nextCursor: null };
  }]);
  await assert.rejects(
    collectMessages({ fetchPage, account: ACCOUNT, chat: CHAT, signal: controller.signal }),
    ChatExportCanceled
  );
});

test('cancelar antes de empezar no fetchea y cancelar entre páginas aborta sin texto', async () => {
  const pre = new AbortController();
  pre.abort();
  const early = fakeFetch([[{ messages: [message('a', 1)], nextCursor: null }]]);
  await assert.rejects(
    collectMessages({ fetchPage: early.fetchPage, account: ACCOUNT, chat: CHAT, signal: pre.signal }),
    ChatExportCanceled
  );
  assert.equal(early.calls.length, 0);

  const controller = new AbortController();
  const calls = [];
  await assert.rejects(
    collectMessages({
      fetchPage: async params => {
        calls.push(params.cursor);
        if (calls.length === 1) {
          controller.abort();
          return { messages: [message('a', 1000)], nextCursor: '1' };
        }
        throw new Error('no debería fetchear la página 2');
      },
      account: ACCOUNT,
      chat: CHAT,
      signal: controller.signal,
    }),
    ChatExportCanceled
  );
  assert.equal(calls.length, 1);
});

test('el límite de memoria es un error explícito, nunca un truncado silencioso', async () => {
  const { fetchPage } = fakeFetch([
    { messages: [message('a', 3), message('b', 2)], nextCursor: '1' },
    { messages: [message('c', 1)], nextCursor: null },
  ]);
  await assert.rejects(
    collectMessages({ fetchPage, account: ACCOUNT, chat: CHAT, limit: 2, maxMessages: 2 }),
    error => error instanceof ChatExportError && /límite de 2 mensajes/.test(error.message)
  );
});

test('createPageFetcher usa before en la URL, valida HTTP y traduce aborts', async () => {
  const urls = [];
  const requestJson = async (url, { signal }) => {
    urls.push({ url, signal: signal === 'sig' });
    return { messages: [message('a', 1)], nextCursor: null };
  };
  const fetchPage = createPageFetcher({ requestJson });
  const page = await fetchPage({ account: ACCOUNT, chat: CHAT, cursor: 'c0', limit: 2, signal: 'sig' });
  assert.equal(page.messages.length, 1);
  assert.equal(queryOf(urls[0].url).get('before'), 'c0');
  assert.equal(urls[0].signal, true);

  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid before' } }) });
  await assert.rejects(
    createPageFetcher({ fetchImpl })({ account: ACCOUNT, chat: CHAT, cursor: 'x' }),
    error => error instanceof ChatExportError && /HTTP 400.*Invalid before/.test(error.message)
  );

  const aborted = createPageFetcher({
    fetchImpl: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  await assert.rejects(aborted({ account: ACCOUNT, chat: CHAT }), ChatExportCanceled);
});

test('renderTranscript: autor Tú/senderName/remitente, adjuntos nombre+tipo, sin tokens ni URLs', () => {
  const messages = [
    { id: '1', timestampMs: 1000, text: 'hola\nsegunda línea', fromMe: true },
    { id: '2', timestampMs: 2000, text: '', fromMe: false, senderName: '  Ana  ', attachments: [
      { name: 'foto\nvia.jpg', mimeType: 'image/jpeg', url: '/api/media/9?account=personal&token=secret' },
      { name: 'image-preview.jpg', mimeType: 'image/jpeg', previewOnly: true, url: '/api/media/thumb/2' },
    ] },
    { id: '3', timestampMs: 3000, text: 'sin nombre', fromMe: false, senderName: null, senderWaId: '34699@lid' },
    { id: '4', timestampMs: 4000, text: '   ', type: 'IMAGE', fromMe: false },
  ];
  const text = renderTranscript({
    account: ACCOUNT,
    chat: CHAT,
    messages,
    generatedAt: new Date(5000),
    duplicatesRemoved: 2,
    formatTimestamp: value => `t${value}`,
  });
  const lines = text.split('\n');
  assert.match(lines[0], /^# Exportación de conversación de WhatsApp$/);
  assert.match(text, /# Mensajes: 4 \(2 duplicados omitidos\)/);
  assert.match(text, /# Nota: solo se incluyen los mensajes sincronizados/);
  assert.ok(lines.includes('[t1000] Tú: hola'));
  assert.ok(lines.includes('  segunda línea'));
  assert.ok(lines.includes('[t2000] Ana:'));
  assert.ok(lines.includes('  · Adjunto: foto via.jpg (image/jpeg)'));
  assert.equal(attachmentLines(messages[1]).length, 1);
  assert.ok(lines.includes('[t3000] 34699@lid: sin nombre'));
  assert.ok(lines.includes('[t4000] Remitente: [Foto: contenido no disponible en la exportación]'));
  assert.ok(!text.includes('/api/media'));
  assert.ok(!text.includes('token=secret'));
  assert.ok(!text.includes('account=personal&'));
  assert.match(text, /# Chat: 346001122@s\.whatsapp\.net/);
  assert.equal(senderLabel({ fromMe: true, senderName: 'X' }), 'Tú');
  assert.equal(senderLabel({ fromMe: false, senderName: ' ' }), 'Remitente');
});

test('formatExportTimestamp formatea en zona horaria explícita o del navegador', () => {
  const utc = formatExportTimestamp(new Date('2026-09-27T12:34:00Z'), { locale: 'en-GB', timeZone: 'UTC' });
  assert.match(utc, /27 .{0,12}2026/);
  assert.match(utc, /12:34/);
  const local = formatExportTimestamp('2026-09-27T12:34:00Z');
  assert.match(local, /2026/);
  assert.notEqual(local.length, 0);
});

test('buildExportFilename limpia traversal, espacios y longitud, y fecha local', () => {
  const date = new Date(2026, 8, 7);
  assert.equal(
    buildExportFilename({ account: ACCOUNT, chat: CHAT, date }),
    'whatsapp-personal-346001122-s.whatsapp.net-2026-09-07.txt'
  );
  const evil = buildExportFilename({ account: '../../etc', chat: '../x@g.us', date });
  assert.ok(!evil.includes('..') && !evil.includes('/') && !evil.includes('\\'));
  assert.ok(evil.startsWith('whatsapp-etc-x-g.us-2026-09-07'));
  const odd = buildExportFilename({ account: 'Mi Cuenta 100%', chat: '🎉@s.whatsapp.net', date });
  assert.ok(!/[Á-ÿA-Z% ]/.test(odd) && odd.endsWith('.txt'));
  const long = buildExportFilename({ account: 'a'.repeat(200), chat: `${'b'.repeat(300)}@s.whatsapp.net`, date });
  assert.ok(long.length <= 127 && long.endsWith('2026-09-07.txt'));
  assert.equal(buildExportFilename({ account: '', chat: '', date }), 'whatsapp-cuenta-chat-2026-09-07.txt');
});

test('exportConversationText integra recolección, render y filename sin parcial si cancela', async () => {
  const pages = [
    { messages: [message('b', '2026-09-02T10:00:00Z', { fromMe: true }), message('a', '2026-09-01T10:00:00Z', { senderName: 'Ana' })], nextCursor: '1' },
    { messages: [message('a', '2026-09-01T10:00:00Z')], nextCursor: null },
  ];
  const { fetchPage } = fakeFetch(pages);
  const { text, filename, stats } = await exportConversationText({
    fetchPage,
    account: ACCOUNT,
    chat: CHAT,
    now: () => new Date(Date.UTC(2026, 8, 3, 12, 0)),
    locale: 'en-GB',
    timeZone: 'UTC',
  });
  assert.equal(stats.pages, 2);
  assert.equal(stats.exported, 2);
  assert.equal(stats.duplicatesRemoved, 1);
  assert.ok(stats.startedAt instanceof Date);
  assert.ok(filename.endsWith('.txt') && filename.includes('personal'));
  assert.match(text, /\[1 .{0,9}2026, 10:00\] Ana: texto a/);
  assert.match(text, /\[2 .{0,9}2026, 10:00\] Tú: texto b/);
  assert.match(text, /# Mensajes: 2 \(1 duplicados omitidos\)/);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    exportConversationText({ fetchPage, account: ACCOUNT, chat: CHAT, signal: controller.signal }),
    ChatExportCanceled
  );
});
