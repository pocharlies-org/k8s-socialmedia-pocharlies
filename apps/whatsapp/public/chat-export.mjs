/**
 * Exportación de conversaciones a TXT, pensada para el menú de chat.
 *
 * Módulo sin DOM e inyectable: las pruebas ejercitan `collectMessages` y
 * `renderTranscript` con un `fetchPage` falso, sin red ni datos reales.
 *
 * Contrato del backend (server.mjs `readMessageRows`):
 *   GET /api/messages?account&chat&limit(≤200)&before=<cursor opaco>
 *   → { messages: [{ id, text, timestamp, fromMe, senderName?, type,
 *                    attachments?: [{ name, mimeType, previewOnly? }] }],
 *       nextCursor: string | null }
 * Cada página viene ordenada de más antigua a más nueva, pero las páginas
 * avanzan hacia el pasado (cursor = última fila de la página). Por eso el
 * resultado global se ordena por (timestamp asc, id asc): coincide con el
 * desempate del servidor y da un orden determinista aunque dos mensajes
 * compartan marca de tiempo.
 */

/** Máximo que acepta el servidor (MAX_PAGE_SIZE en server.mjs). */
export const CHAT_EXPORT_LIMIT = 200;
/** Techo explícito de memoria: superarlo es un error, nunca un truncado. */
export const CHAT_EXPORT_MAX_MESSAGES = 50_000;

export class ChatExportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ChatExportError';
  }
}

export class ChatExportCanceled extends Error {
  constructor(message = 'Exportación cancelada.', options) {
    super(message, options);
    this.name = 'ChatExportCanceled';
  }
}

export function buildMessagesUrl({ account, chat, cursor = null, limit = CHAT_EXPORT_LIMIT }) {
  if (typeof account !== 'string' || !account) throw new ChatExportError('Cuenta de exportación no válida.');
  if (typeof chat !== 'string' || !chat) throw new ChatExportError('Chat de exportación no válido.');
  if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_EXPORT_LIMIT) {
    throw new ChatExportError(`El límite por página debe estar entre 1 y ${CHAT_EXPORT_LIMIT}.`);
  }
  const query = new URLSearchParams({ account, chat, limit: String(limit) });
  if (cursor) query.set('before', cursor);
  return `/api/messages?${query.toString()}`;
}

/**
 * Fetcher por defecto. `requestJson(url, { signal })` debe resolver con el
 * JSON ya validado como respuesta de página (se revalida igualmente).
 */
export function createPageFetcher({ requestJson, fetchImpl = globalThis.fetch }) {
  const call = requestJson || (async (url, options) => {
    const response = await fetchImpl(url, { credentials: 'same-origin', ...options });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ChatExportError(`Error al leer mensajes (HTTP ${response.status}${body?.error?.message ? `: ${body.error.message}` : ''}).`);
    }
    return response.json();
  });
  return async ({ account, chat, cursor, limit, signal }) => {
    const url = buildMessagesUrl({ account, chat, cursor, limit });
    try {
      return await call(url, { signal });
    } catch (error) {
      if (error instanceof ChatExportError || error instanceof ChatExportCanceled) throw error;
      if (signal?.aborted || error?.name === 'AbortError') throw new ChatExportCanceled(undefined, { cause: error });
      throw new ChatExportError('No se pudo leer una página de mensajes.', { cause: error });
    }
  };
}

function validatePage(page) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) {
    throw new ChatExportError('Respuesta de mensajes no válida (sin objeto de página).');
  }
  if (!Array.isArray(page.messages)) {
    throw new ChatExportError('Respuesta de mensajes no válida (falta la lista de mensajes).');
  }
  if (!('nextCursor' in page)) {
    throw new ChatExportError('Respuesta de mensajes no válida (falta nextCursor).');
  }
  const next = page.nextCursor;
  if (next !== null && (typeof next !== 'string' || next === '')) {
    throw new ChatExportError('Respuesta de mensajes no válida (cursor malformado).');
  }
  if (page.messages.length === 0 && next) {
    throw new ChatExportError('Respuesta de mensajes no válida (página vacía con cursor).');
  }
  return next;
}

/**
 * Descarga todas las páginas disponibles. `fetchPage({ account, chat,
 * cursor, limit, signal })` resuelve con `{ messages, nextCursor }`.
 * La cuenta y el chat se capturan al iniciar: ningún cambio posterior del
 * llamante puede mezclar páginas de otra cuenta.
 */
export async function collectMessages({
  fetchPage,
  account,
  chat,
  limit = CHAT_EXPORT_LIMIT,
  maxMessages = CHAT_EXPORT_MAX_MESSAGES,
  maxPages = Math.ceil(CHAT_EXPORT_MAX_MESSAGES / CHAT_EXPORT_LIMIT) + 2,
  onProgress,
  signal,
}) {
  if (typeof fetchPage !== 'function') throw new ChatExportError('Falta la función de lectura de páginas.');
  const capturedAccount = account;
  const capturedChat = chat;
  buildMessagesUrl({ account: capturedAccount, chat: capturedChat, limit });
  const byId = new Map();
  const seenCursors = new Set();
  let cursor = null;
  let pages = 0;
  let duplicatesRemoved = 0;
  for (;;) {
    if (signal?.aborted) throw new ChatExportCanceled();
    const page = await (async () => {
      try {
        return await fetchPage({ account: capturedAccount, chat: capturedChat, cursor, limit, signal });
      } catch (error) {
        if (error instanceof ChatExportError || error instanceof ChatExportCanceled) throw error;
        if (signal?.aborted || error?.name === 'AbortError') throw new ChatExportCanceled(undefined, { cause: error });
        throw new ChatExportError('No se pudo leer una página de mensajes.', { cause: error });
      }
    })();
    if (signal?.aborted) throw new ChatExportCanceled();
    pages += 1;
    const nextCursor = validatePage(page);
    for (const row of page.messages) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) {
        throw new ChatExportError('Respuesta de mensajes no válida (mensaje sin id).');
      }
      const timestampMs = Date.parse(row.timestamp);
      if (!Number.isFinite(timestampMs)) {
        throw new ChatExportError(`Mensaje ${row.id} sin marca de tiempo válida.`);
      }
      if (byId.has(row.id)) duplicatesRemoved += 1;
      else byId.set(row.id, { ...row, timestampMs });
      if (byId.size > maxMessages) {
        throw new ChatExportError(`La conversación supera el límite de ${maxMessages} mensajes; reduce el tramo de exportación.`);
      }
    }
    onProgress?.({ pages, messages: byId.size, duplicatesRemoved });
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) {
      throw new ChatExportError('El servidor repitió un cursor de paginación; exportación detenida sin resultado parcial.');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    if (pages >= maxPages) {
      throw new ChatExportError(`Se superaron las ${maxPages} páginas de paginación permitidas.`);
    }
  }
  const messages = [...byId.values()].sort(
    (a, b) => a.timestampMs - b.timestampMs || String(a.id).localeCompare(String(b.id))
  );
  return { messages, stats: { pages, exported: messages.length, duplicatesRemoved } };
}

const formatterCache = new Map();

/** Formato legible en la zona horaria del navegador (Intl). */
export function formatExportTimestamp(value, { locale, timeZone } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ChatExportError('Marca de tiempo no válida.');
  const key = `${locale ?? 'default'}|${timeZone ?? 'local'}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) });
    formatterCache.set(key, formatter);
  }
  return formatter.format(date);
}

export function senderLabel(message, { meLabel = 'Tú', unknownLabel = 'Remitente' } = {}) {
  if (message.fromMe === true) return meLabel;
  const name = typeof message.senderName === 'string' ? message.senderName.trim() : '';
  if (name) return name;
  const sender = typeof message.senderWaId === 'string' && message.senderWaId
    ? message.senderWaId
    : typeof message.sender === 'string' && message.sender ? message.sender : '';
  return sender || unknownLabel;
}

function cleanAttachmentName(name) {
  const cleaned = String(name || 'adjunto').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'adjunto').slice(0, 120);
}

/** Adjuntos como nombre+tipo; sin URLs (llevan sesión/tokens) ni media. */
export function attachmentLines(message) {
  return (Array.isArray(message.attachments) ? message.attachments : [])
    .filter(item => item && item.previewOnly !== true)
    .map(item => `  · Adjunto: ${cleanAttachmentName(item.name)} (${item.mimeType || 'desconocido'})`);
}

/**
 * Transcripción legible: cabecera con contexto y notas, luego una línea por
 * mensaje en orden cronológico ascendente. `formatTimestamp` es inyectable
 * para pruebas deterministas.
 */
export function renderTranscript({
  account,
  chat,
  messages,
  duplicatesRemoved = 0,
  generatedAt = new Date(),
  locale,
  timeZone,
  formatTimestamp = value => formatExportTimestamp(value, { locale, timeZone }),
  meLabel = 'Tú',
} = {}) {
  const lines = [
    '# Exportación de conversación de WhatsApp',
    `# Cuenta: ${account}`,
    `# Chat: ${chat}`,
    `# Generado: ${formatTimestamp(generatedAt)}`,
    `# Mensajes: ${messages.length}${duplicatesRemoved ? ` (${duplicatesRemoved} duplicados omitidos)` : ''}`,
    '# Nota: solo se incluyen los mensajes sincronizados con esta base de datos; el historial del proveedor puede ser más amplio.',
    '',
  ];
  for (const message of messages) {
    let text = typeof message.text === 'string' ? message.text : '';
    const attachments = attachmentLines(message);
    if (!text.trim() && !attachments.length) {
      const labels = { IMAGE: 'Foto', VIDEO: 'Vídeo', AUDIO: 'Audio', VOICE: 'Nota de voz', DOCUMENT: 'Documento', STICKER: 'Sticker', POLL: 'Encuesta', LOCATION: 'Ubicación', CONTACT: 'Contacto', EVENT: 'Evento' };
      text = `[${labels[message.type] || 'Mensaje'}: contenido no disponible en la exportación]`;
    }
    lines.push(`[${formatTimestamp(message.timestampMs)}] ${senderLabel(message, { meLabel })}: ${text.split('\n')[0]}`.trimEnd());
    for (const extra of text.split('\n').slice(1)) lines.push(`  ${extra}`);
    lines.push(...attachments);
  }
  return `${lines.join('\n')}\n`;
}

function sanitizeSegment(value, maxLength) {
  const lowered = String(value ?? '').toLowerCase();
  const cleaned = lowered.replace(/[^a-z0-9.]+/g, '-').replace(/-+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, maxLength);
}

/** Nombre de archivo legible, sin separadores de ruta ni «..». */
export function buildExportFilename({ account, chat, date = new Date(), prefix = 'whatsapp' } = {}) {
  const day = new Date(date);
  const stamp = Number.isFinite(day.getTime()) ? day : new Date();
  const pad = part => String(part).padStart(2, '0');
  const datePart = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`;
  const accountPart = sanitizeSegment(account, 32) || 'cuenta';
  const jid = /^(.{1,80})@(.{1,80})$/.exec(String(chat ?? ''));
  const chatSource = jid ? `${jid[1]}-${jid[2]}` : String(chat ?? '');
  let chatPart = sanitizeSegment(chatSource, 48) || 'chat';
  let name = `${prefix}-${accountPart}-${chatPart}-${datePart}.txt`;
  if (name.length > 127) {
    chatPart = chatPart.slice(0, Math.max(1, chatPart.length - (name.length - 127))).replace(/[-.]+$/g, '');
    name = `${prefix}-${accountPart}-${chatPart || 'chat'}-${datePart}.txt`;
  }
  return name;
}

/**
 * Interfaz de integración para el menú (el menú mantiene el progreso y la
 * cancelación):
 *
 *   const controller = new AbortController();
 *   const { text, filename, stats } = await exportConversationText({
 *     fetchPage: createPageFetcher({}),           // o requestJson propio
 *     account: state.account,
 *     chat: state.selectedChat.id,
 *     onProgress: ({ pages, messages }) => aviso(`Exportando… ${messages} mensajes (${pages} páginas)`),
 *     signal: controller.signal,                  // botón Cancelar → abort()
 *   });
 *   // Guardar: saveAs(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename)
 *
 * `ChatExportCanceled` → aviso silencioso «cancelado»; `ChatExportError` →
 * aviso de error con `error.message`. Nunca devuelve texto parcial.
 */
export async function exportConversationText({
  fetchPage,
  account,
  chat,
  limit,
  maxMessages,
  maxPages,
  onProgress,
  signal,
  now = () => new Date(),
  locale,
  timeZone,
  meLabel = 'Tú',
} = {}) {
  const startedAt = new Date();
  const collected = await collectMessages({ fetchPage, account, chat, limit, maxMessages, maxPages, onProgress, signal });
  const generatedAt = now();
  const text = renderTranscript({
    account,
    chat,
    messages: collected.messages,
    duplicatesRemoved: collected.stats.duplicatesRemoved,
    generatedAt,
    locale,
    timeZone,
    meLabel,
  });
  return { text, filename: buildExportFilename({ account, chat, date: generatedAt }), stats: { ...collected.stats, startedAt } };
}
