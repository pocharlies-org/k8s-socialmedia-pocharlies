import { createHash } from 'node:crypto';
import { MESSAGE_RETAINED_SQL, MESSAGE_VISIBLE_SQL, readableChatName } from './chat-names.mjs';
import { fail } from './security.mjs';
import { getDatabaseSchema, validDatabaseId } from './database-schema.mjs';
import { linkPreviewFromPayload } from './link-preview.mjs';

function validId(value, type) {
  return typeof value === 'string' && validDatabaseId(value, type);
}

function choice(params, key, fallback, values) {
  const value = params.get(key) || fallback;
  if (!values.includes(value)) throw fail(400, `Invalid ${key}`);
  return value;
}

function storedDuration(row) {
  return [row.duration_seconds, row.duration].map(Number)
    .find(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647) || null;
}

export function mediaLibraryOptions(account, params) {
  const kind = choice(params, 'kind', 'media', ['media', 'documents', 'links', 'all']);
  const sender = choice(params, 'sender', 'all', ['all', 'me', 'others']);
  const order = choice(params, 'order', 'newest', ['newest', 'oldest', 'longest']);
  const q = (params.get('q') || '').trim();
  if (q.length > 400) throw fail(400, 'Query is too long');
  const limit = Number(params.get('limit') || 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw fail(400, 'Invalid limit');
  const scope = createHash('sha256').update(JSON.stringify([account, kind, sender, order, q])).digest('hex');
  let cursor = null;
  if (params.has('cursor')) {
    try {
      const raw = params.get('cursor');
      if (!raw || raw.length > 2048) throw new Error();
      cursor = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (cursor.scope !== scope || typeof cursor.timestamp !== 'string' || !Number.isFinite(Date.parse(cursor.timestamp)) ||
          !(validId(cursor.id, 'uuid') || validId(cursor.id, 'bigint')) ||
          typeof cursor.attachment !== 'string' || (cursor.attachment && !(validId(cursor.attachment, 'uuid') || validId(cursor.attachment, 'bigint'))) ||
          (order === 'longest' && (!Number.isSafeInteger(cursor.duration) || cursor.duration < -1 || cursor.duration > 2147483647))) throw new Error();
    } catch { throw fail(400, 'Invalid media cursor'); }
  }
  return { kind, sender, order, q, limit, scope, cursor };
}

export function publicLinks(value) {
  const found = new Set();
  for (const match of String(value || '').matchAll(/https?:\/\/[^\s<>]+/gi)) {
    const candidate = match[0].replace(/[),.!?;:\]}'"]+$/, '');
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      found.add(url.href);
    } catch { /* Malformed links are not actionable. */ }
  }
  return [...found].map(url => ({ url }));
}

export async function readMediaLibrary({ account, params, query }) {
  const options = mediaLibraryOptions(account, params);
  const schema = await getDatabaseSchema(query);
  if (options.cursor && (!validId(options.cursor.id, schema.messageIdType) ||
      (options.cursor.attachment && !validId(options.cursor.attachment, schema.attachmentIdType)))) {
    throw fail(400, 'Invalid media cursor');
  }
  const args = [account];
  const where = ["m.account=$1", "m.platform='whatsapp'", 'NOT m.is_deleted', MESSAGE_RETAINED_SQL, MESSAGE_VISIBLE_SQL];
  const isLinks = options.kind === 'links';
  const durationOrder = options.order === 'longest';
  const attachmentId = isLinks ? "''::text" : "COALESCE(a.id::text, '')";
  const emptyAttachment = schema.attachmentIdType === 'uuid' ? '00000000-0000-0000-0000-000000000000' : '0';
  const attachmentKey = isLinks ? "''::text" : `COALESCE(a.id, '${emptyAttachment}'::${schema.attachmentIdType})`;
  // Only columns discovered from the allowlisted schema are referenced in SQL.
  const durationColumns = ['duration_seconds', 'duration'].filter(column => schema.attachmentDurationColumns.includes(column));
  const durationKey = isLinks || !durationColumns.length ? '(-1)::int' : `COALESCE(${durationColumns.map(column =>
    `CASE WHEN a.${column} BETWEEN 1 AND 2147483647 THEN a.${column} END`).join(', ')}, -1)`;
  if (isLinks) where.push("m.content ~* 'https?://[^[:space:]]+'");
  else if (options.kind === 'documents') where.push("m.message_type='DOCUMENT'");
  else if (options.kind === 'all') where.push("(m.message_type IN ('IMAGE','VIDEO','AUDIO','STICKER','DOCUMENT') OR m.content ~* 'https?://[^[:space:]]+')");
  else where.push("m.message_type IN ('IMAGE','VIDEO','AUDIO','STICKER')");
  if (options.sender !== 'all') where.push(`m.direction ${options.sender === 'me' ? '=' : '<>'} 'OUTBOUND'`);
  if (options.q) {
    args.push(`%${options.q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(m.content ILIKE $${args.length} OR c.name ILIKE $${args.length}
      OR sender.name ILIKE $${args.length} OR sender.push_name ILIKE $${args.length}${isLinks ? '' : ` OR a.file_name ILIKE $${args.length}`})`);
  }
  const direction = options.order === 'oldest' ? 'ASC' : 'DESC';
  if (options.cursor) {
    if (durationOrder) args.push(options.cursor.duration);
    args.push(options.cursor.timestamp, options.cursor.id, isLinks ? '' : options.cursor.attachment || emptyAttachment);
    const end = args.length;
    where.push(durationOrder
      ? `(${durationKey}, m.wa_timestamp, m.id, ${attachmentKey}) < ($${end - 3}::int, $${end - 2}::timestamptz, $${end - 1}::${schema.messageIdType}, $${end}::${isLinks ? 'text' : schema.attachmentIdType})`
      : `(m.wa_timestamp, m.id, ${attachmentKey}) ${direction === 'DESC' ? '<' : '>'} ($${end - 2}::timestamptz, $${end - 1}::${schema.messageIdType}, $${end}::${isLinks ? 'text' : schema.attachmentIdType})`);
  }
  args.push(options.limit + 1);
  const rows = await query(`SELECT m.id::text AS id, m.wa_message_id, m.conversation_id, m.content,
      m.direction, m.message_type, m.wa_timestamp, m.wa_timestamp::text AS cursor_timestamp,
      c.name AS chat_name, ${attachmentId} AS attachment_id
      ${isLinks ? ', p.message_payload->\'extendedTextMessage\' AS preview_payload' : `, a.mime_type, a.file_name, a.file_size${durationColumns.map(column => `, a.${column}`).join('')}`}
    FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.account=m.account
    ${options.q ? 'LEFT JOIN participants sender ON sender.id=m.sender_wa_id AND sender.account=m.account' : ''}
    ${isLinks ? 'LEFT JOIN whatsapp_message_payloads p ON p.wa_message_id=m.wa_message_id AND p.account=m.account AND pg_column_size(p.message_payload->\'extendedTextMessage\') <= 300000' : ''}
    ${isLinks ? '' : 'LEFT JOIN attachments a ON a.message_id=m.id'}
    WHERE ${where.join(' AND ')}
    ORDER BY ${durationOrder ? `${durationKey} DESC, ` : ''}m.wa_timestamp ${direction}, m.id ${direction}, ${attachmentKey} ${direction}
    LIMIT $${args.length}`, args);
  const page = rows.slice(0, options.limit);
  const items = page.map(row => {
    const kind = isLinks || options.kind === 'all' && !['IMAGE', 'VIDEO', 'AUDIO', 'STICKER', 'DOCUMENT'].includes(row.message_type)
      ? 'link' : ({ IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', STICKER: 'image' }[row.message_type] || 'document');
    const links = kind === 'link' ? publicLinks(row.content) : [];
    if (links.length && row.preview_payload) {
      // El helper solo titulará una URL que esté de verdad en el mensaje (matchedText/canonicalUrl).
      const preview = linkPreviewFromPayload(row.content, { extendedTextMessage: row.preview_payload });
      const target = links.find(link => link.url === preview?.url);
      if (target && preview.title) target.title = preview.title;
    }
    return {
      id: row.attachment_id || row.id, kind,
      chatId: row.conversation_id,
      chatName: readableChatName({ id: row.conversation_id, name: row.chat_name }),
      messageId: row.id, timestamp: row.wa_timestamp, fromMe: row.direction === 'OUTBOUND',
      name: row.file_name || (kind === 'link' ? links[0]?.url : null), mimeType: row.mime_type || null,
      size: row.file_size || null, durationSeconds: storedDuration(row),
      text: row.content || '',
      url: kind === 'link' ? links[0]?.url || null : row.attachment_id
        ? `/api/media/${encodeURIComponent(row.attachment_id)}?account=${encodeURIComponent(account)}&chat=${encodeURIComponent(row.conversation_id)}` : null,
      ...(kind === 'link' ? { links } : {}),
    };
  });
  const last = page.at(-1);
  const nextCursor = rows.length > options.limit && last ? Buffer.from(JSON.stringify({
    scope: options.scope, timestamp: last.cursor_timestamp || new Date(last.wa_timestamp).toISOString(),
    id: String(last.id), attachment: String(last.attachment_id || ''),
    ...(durationOrder ? { duration: isLinks ? -1 : storedDuration(last) ?? -1 } : {}),
  })).toString('base64url') : null;
  return { account, items, nextCursor };
}
