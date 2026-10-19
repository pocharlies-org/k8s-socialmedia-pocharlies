import { CHAT_LIST_BASE_SQL } from './chat-names.mjs';

const sortTime = 'COALESCE(last_message.wa_timestamp, c.last_message_at)';
const invalid = () => Object.assign(new Error('Invalid chat cursor'), { status: 400 });

function decodeCursor(value, account, archived) {
  if (!value) return null;
  try {
    if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (cursor.v !== 1 || cursor.account !== account || cursor.archived !== archived
      || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 512
      || (cursor.time !== null && (typeof cursor.time !== 'string'
        || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/.test(cursor.time)
        || !Number.isFinite(Date.parse(cursor.time))))) throw invalid();
    return cursor;
  } catch { throw invalid(); }
}

export async function readChatDirectory({ query, account, archived = false, cursor: rawCursor, limit: rawLimit }) {
  const limit = rawLimit == null || rawLimit === '' ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw Object.assign(new Error('Invalid chat page size'), { status: 400 });
  const cursor = decodeCursor(rawCursor, account, archived);
  const args = [account, archived];
  let after = '';
  if (cursor) {
    args.push(cursor.id);
    if (cursor.time === null) after = `AND ${sortTime} IS NULL AND c.id < $3`;
    else {
      args.push(cursor.time);
      after = `AND (${sortTime} IS NULL OR ${sortTime} < $4::timestamp OR (${sortTime} = $4::timestamp AND c.id < $3))`;
    }
  }
  args.push(limit + 1);
  const rows = await query(`${CHAT_LIST_BASE_SQL}
AND (COALESCE(c.archived, false) OR COALESCE(pn_alias.archived, false)) = $2
${after}
ORDER BY ${sortTime} DESC NULLS LAST, c.id DESC
LIMIT $${args.length}`, args);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  // Keep PostgreSQL's microseconds intact: JS Date would lose the cursor boundary.
  const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({
    v: 1, account, archived, id: last.id, time: last._sortTimestamp ?? null,
  })).toString('base64url') : null;
  return { chats: page.map(({ _sortTimestamp, ...chat }) => chat), nextCursor };
}
