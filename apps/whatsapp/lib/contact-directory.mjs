import { fail } from './security.mjs';

/*
 * Contact directory behind the "Nuevo chat" drawer.
 *
 * The connector's GET /contacts answers from the same table read here, but it
 * stops at 500 rows with no cursor and its envelope does not name the account
 * it belongs to, so it cannot drive a browsable directory. Reading the
 * account-scoped tables directly keeps the page size, the search and the total
 * honest, and never asks the provider for anything.
 *
 * Identity rules the stored data forces:
 * - A `@lid` JID is WhatsApp's privacy identifier, not a phone number. The
 *   connector stores the LID's own digits in `whatsapp_contacts.phone`, so a
 *   number taken from a LID row would be invented. Only `@c.us` and
 *   `@s.whatsapp.net` identities carry a real number, exactly as the
 *   connector's own `pnJidToE164` decides.
 * - A direct chat is stored under whichever address the provider used, so one
 *   person can exist as a phone chat and a LID chat whose `wa_chat_id` names
 *   the phone. Those rows merge, and the chat kept for opening is the one the
 *   sidebar opens (the LID row, matching `conversationFor`).
 * - The LID to phone mapping is only learned from this account's own direct
 *   chats. Contact rows and group members that are LID-only never borrow a
 *   number from a mapping that was not observed for them.
 */

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 60;
const MAX_QUERY_LENGTH = 200;
// The keyset cursor carries the sort key verbatim, so the SQL projection and
// the cursor validator have to agree on how long it is and on what one
// character means: PostgreSQL counts codepoints in `LEFT()`, so the validator
// counts them through `Array.from()` instead of UTF-16 units, which an emoji
// name would otherwise blow past the cap.
const LABEL_SORT_LIMIT = 600;
const LABEL_KEY_LIMIT = 340;
const CURSOR_RAW_LIMIT = 8192;

/** Codepoints, the unit PostgreSQL truncates in, not UTF-16 units. */
function length(value) {
  return Array.from(String(value)).length;
}
// One digit matches a large part of a thousand-row directory, so a numeric
// search has to mean something before it answers.
const MIN_PHONE_QUERY_DIGITS = 2;
const PRIVATE_LABEL = 'ID privado';
const DIRECT_REALMS = "IN ('@lid', '@c.us', '@s.whatsapp.net')";

/** Strip the `account:` namespace without eating a `1234:1@lid` device suffix. */
function bare(column) {
  return `CASE WHEN ${column} ~ '^[a-zA-Z][a-zA-Z0-9_.-]*:[0-9]' THEN substring(${column} FROM '^[^:]+:(.*)$') ELSE ${column} END`;
}

function userPart(column) {
  return `split_part(regexp_replace(${bare(column)}, '@.*$', ''), ':', 1)`;
}

function realm(column) {
  return `substring(${bare(column)} FROM '@[a-z.]+$')`;
}

/** Digits of a phone-number identity; NULL for a LID, group or channel. */
function phoneDigits(column) {
  const user = userPart(column);
  return `CASE WHEN ${realm(column)} IN ('@c.us', '@s.whatsapp.net') AND ${user} ~ '^[0-9]{6,15}$' THEN ${user} END`;
}

function lidDigits(column) {
  return `CASE WHEN ${realm(column)} = '@lid' THEN ${userPart(column)} END`;
}

/** Keep only identifiers this directory can address: a number or a private id. */
function addressable(column) {
  return `(${phoneDigits(column)} IS NOT NULL OR ${lidDigits(column)} IS NOT NULL)`;
}

/** A stored title that repeats the provider identifier is not a name. */
function usefulName(name, id) {
  return `CASE WHEN ${name} IS NULL OR BTRIM(${name}) = ''
      OR BTRIM(${name}) ~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$'
      OR BTRIM(${name}) = ${bare(id)} OR BTRIM(${name}) = ${userPart(id)}
    THEN NULL ELSE BTRIM(${name}) END`;
}

function candidateQueries(shape) {
  const chats = [
    'chats AS (',
    `  SELECT ${phoneDigits('t.id')} AS phone, ${lidDigits('t.id')} AS lid, ${phoneDigits('t.wa_chat_id')} AS linked_phone,`,
    `         ${usefulName('t.name', 't.id')} AS name, NULL::text AS push_name,`,
    '         t.id AS chat_id, COALESCE(t.archived, false) AS chat_archived,',
    '         NULL::text AS participant_id, NULL::text AS photo_url,',
    '         1 AS origin_rank, NULL::timestamptz AS synced_at',
    '    FROM conversations t',
    '   WHERE t.account = $1 AND COALESCE(t.is_group, false) = false',
    `     AND ${realm('t.id')} ${DIRECT_REALMS} AND ${addressable('t.id')}`,
    ')',
  ].join('\n');
  const contacts = [
    'contacts AS (',
    `  SELECT ${phoneDigits('c.jid')} AS phone, ${lidDigits('c.jid')} AS lid, NULL::text AS linked_phone,`,
    `         ${usefulName('c.name', 'c.jid')} AS name, ${usefulName('c.push_name', 'c.jid')} AS push_name,`,
    '         NULL::text AS chat_id, false AS chat_archived,',
    '         NULL::text AS participant_id, NULL::text AS photo_url,',
    '         2 AS origin_rank, c.updated_at AS synced_at',
    '    FROM whatsapp_contacts c',
    '   WHERE c.account = $1',
    `     AND ${realm('c.jid')} ${DIRECT_REALMS} AND ${addressable('c.jid')}`,
    ')',
  ].join('\n');
  const people = [
    'people AS (',
    `  SELECT ${phoneDigits('p.id')} AS phone, ${lidDigits('p.id')} AS lid, NULL::text AS linked_phone,`,
    `         ${usefulName('p.name', 'p.id')} AS name, ${usefulName('p.push_name', 'p.id')} AS push_name,`,
    '         NULL::text AS chat_id, false AS chat_archived,',
    "         p.id AS participant_id, NULLIF(BTRIM(p.profile_pic_url), '') AS photo_url,",
    '         3 AS origin_rank, NULL::timestamptz AS synced_at',
    '    FROM participants p',
    '   WHERE p.account = $1',
    `     AND ${realm('p.id')} ${DIRECT_REALMS} AND ${addressable('p.id')}`,
    ')',
  ].join('\n');
  return [chats, ...(shape.includeContacts ? [contacts] : []), people];
}

function directoryCtes(shape) {
  const union = ['chats', ...(shape.includeContacts ? ['contacts'] : []), 'people']
    .map(name => `SELECT * FROM ${name}`).join('\n  UNION ALL\n  ');
  return [...candidateQueries(shape), `unioned AS (
  ${union}
),
lid_map AS (
  SELECT c.lid, max(c.linked_phone) AS phone
    FROM chats c
   WHERE c.lid IS NOT NULL AND c.linked_phone IS NOT NULL
   GROUP BY c.lid
),
resolved AS (
  SELECT COALESCE(u.phone, u.linked_phone, lm.phone, 'lid:' || u.lid) AS key,
         COALESCE(u.phone, u.linked_phone, lm.phone) AS phone,
         COALESCE(u.lid, lm.lid) AS lid,
         u.name, u.push_name, u.chat_id, u.chat_archived, u.participant_id, u.photo_url,
         u.origin_rank, u.synced_at,
         (u.lid IS NOT NULL AND u.phone IS NULL AND u.linked_phone IS NULL AND lm.lid IS NULL) AS unmapped_lid
    FROM unioned u
    LEFT JOIN lid_map lm ON lm.lid = u.lid AND u.lid IS NOT NULL
),
merged AS (
  SELECT r.key,
         max(r.phone) AS phone,
         max(r.lid) AS lid,
         (array_agg(r.name ORDER BY (r.name IS NULL), (r.origin_rank <> 2), r.synced_at DESC NULLS LAST, r.origin_rank))[1] AS name,
         (array_agg(r.push_name ORDER BY (r.push_name IS NULL), r.origin_rank))[1] AS push_name,
         (array_agg(r.chat_id ORDER BY (r.chat_id IS NULL), (r.lid IS NOT NULL) DESC, r.origin_rank, r.chat_id))[1] AS chat_id,
         (array_agg(r.chat_archived ORDER BY (r.chat_id IS NULL), (r.lid IS NOT NULL) DESC, r.origin_rank, r.chat_id) FILTER (WHERE r.chat_id IS NOT NULL))[1] AS chat_archived,
         (array_agg(r.photo_url ORDER BY (r.photo_url IS NULL)) FILTER (WHERE r.photo_url IS NOT NULL))[1] AS photo_url,
         (array_agg(r.participant_id ORDER BY (r.photo_url IS NULL)) FILTER (WHERE r.photo_url IS NOT NULL))[1] AS photo_owner,
         bool_or(r.chat_id IS NOT NULL) AS has_chat,
         min(r.origin_rank) AS origin_rank,
         max(r.synced_at) AS synced_at
    FROM resolved r
   GROUP BY r.key
),
projected AS (
  SELECT m.key, m.phone, m.lid, m.chat_id, m.has_chat, COALESCE(m.chat_archived, false) AS chat_archived,
         m.photo_url, m.photo_owner, m.origin_rank,
         COALESCE(m.name, m.push_name, CASE WHEN m.phone IS NOT NULL THEN '+' || m.phone END, '${PRIVATE_LABEL}') AS label,
         LEFT(LOWER(COALESCE(m.name, m.push_name, CASE WHEN m.phone IS NOT NULL THEN '+' || m.phone END, '${PRIVATE_LABEL}')), ${LABEL_SORT_LIMIT}) AS label_sort,
         CASE WHEN m.has_chat THEN 1
              WHEN m.phone IS NOT NULL THEN 2
              WHEN COALESCE(m.name, m.push_name) IS NOT NULL THEN 3
              ELSE 4 END AS label_rank,
         CASE WHEN m.name IS NOT NULL THEN 'saved'
              WHEN m.push_name IS NOT NULL THEN 'push'
              WHEN m.has_chat THEN 'chat'
              WHEN m.phone IS NOT NULL THEN 'number'
              ELSE 'private' END AS source
    FROM merged m
)`].join(',\n');
}

// Rows are grouped by what the drawer can actually do with them (open a chat,
// start one, browse only) and alphabetical inside each group, because a
// thousand synchronised LIDs would otherwise bury every reachable contact.
function searchClause(q, args) {
  if (/^\+?[\d][\d +().-]*$/.test(q)) {
    const digits = q.replace(/\D/g, '');
    if (digits.length < MIN_PHONE_QUERY_DIGITS) throw fail(400, 'Escribe al menos dos dígitos de un número');
    args.push(digits);
    return `(projected.phone LIKE '%' || $${args.length} || '%' OR projected.lid LIKE '%' || $${args.length} || '%')`;
  }
  args.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
  return `projected.label ILIKE $${args.length}`;
}

export function contactDirectoryOptions(account, params) {
  if (typeof account !== 'string' || !account.trim()) throw fail(400, 'Invalid account');
  const q = (params.get('q') || '').trim().slice(0, MAX_QUERY_LENGTH);
  const limit = Number(params.get('limit') || DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw fail(400, 'Invalid limit');
  let cursor = null;
  const raw = params.get('cursor');
  if (raw) {
    if (raw.length > CURSOR_RAW_LIMIT) throw fail(400, 'Invalid contact cursor');
    let parsed;
    try { parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw fail(400, 'Invalid contact cursor'); }
    const valid = parsed && typeof parsed === 'object'
      && Number.isInteger(parsed.rank) && parsed.rank >= 1 && parsed.rank <= 4
      && typeof parsed.sort === 'string' && length(parsed.sort) > 0 && length(parsed.sort) <= LABEL_SORT_LIMIT
      && typeof parsed.key === 'string' && length(parsed.key) > 0 && length(parsed.key) <= LABEL_KEY_LIMIT;
    if (!valid) throw fail(400, 'Invalid contact cursor');
    cursor = { rank: parsed.rank, sort: parsed.sort, key: parsed.key };
  }
  return { q, limit, cursor };
}

// The order is stable rather than locale-pretty: the cursor stores the exact
// `label_sort` PostgreSQL produced, so a page boundary cannot skip or repeat an
// entry because a browser would have collated two names differently.
function pageQuery(shape, account, options) {
  const args = [account];
  const where = [];
  if (options.q) where.push(searchClause(options.q, args));
  if (options.cursor) {
    const index = args.length + 1;
    args.push(options.cursor.rank, options.cursor.sort, options.cursor.key);
    where.push(`(projected.label_rank, projected.label_sort COLLATE "C", projected.key COLLATE "C") > ($${index}::int, $${index + 1}::text, $${index + 2}::text)`);
  }
  args.push(options.limit + 1);
  const selects = ['projected.key', 'projected.phone', 'projected.lid', 'projected.chat_id', 'projected.has_chat',
    'projected.chat_archived', 'projected.photo_url', 'projected.photo_owner', 'projected.origin_rank',
    'projected.label', 'projected.label_sort', 'projected.label_rank', 'projected.source'];
  return {
    args,
    sql: [`WITH ${directoryCtes(shape)}`,
      `SELECT ${selects.join(', ')}`,
      '  FROM projected',
      ` WHERE ${where.length ? where.join(' AND ') : 'TRUE'}`,
      ' ORDER BY projected.label_rank, projected.label_sort COLLATE "C", projected.key COLLATE "C"',
      ` LIMIT $${args.length}`].join('\n'),
  };
}

function statsQuery(shape, account, options) {
  const args = [account];
  const search = options.q ? searchClause(options.q, args) : '';
  const contactStats = shape.includeContacts
    ? ['(SELECT count(*) FROM contacts) AS "contactIdentities"',
       '(SELECT count(*) FROM contacts WHERE name IS NOT NULL) AS "savedNames"',
       '(SELECT max(synced_at)::text FROM contacts) AS "latestSyncAt"']
    : ['0::bigint AS "contactIdentities"', '0::bigint AS "savedNames"', 'NULL::text AS "latestSyncAt"'];
  const selects = [
    '(SELECT count(*) FROM projected) AS total',
    search ? `(SELECT count(*) FROM projected WHERE ${search}) AS matched` : '(SELECT count(*) FROM projected) AS matched',
    '(SELECT count(*) FROM chats) AS "directChatIdentities"',
    '(SELECT count(*) FROM people) AS "groupMemberIdentities"',
    ...contactStats,
    '(SELECT count(*) FROM resolved r WHERE r.unmapped_lid AND r.chat_id IS NOT NULL) AS "unmappedLidChats"',
  ];
  return { args, sql: [`WITH ${directoryCtes(shape)}`, `SELECT ${selects.join(',\n       ')}`].join('\n') };
}

function lastDigits(value) {
  return String(value || '').slice(-3);
}

function publicEntry(entry, account) {
  const phone = entry.phone ? `+${entry.phone}` : null;
  const label = entry.label;
  // Provider and stored photo URLs never reach the browser. Avatars reuse the
  // authenticated proxies: the chat one for conversations the sidebar already
  // loads, and the participant one only when a photo is already stored, so
  // browsing the directory never asks the provider for 60 profile pictures.
  const avatarUrl = entry.chat_id
    ? `/api/chats/${encodeURIComponent(entry.chat_id)}/avatar?account=${encodeURIComponent(account)}`
    : (entry.photo_url && entry.photo_owner
      ? `/api/contacts/${encodeURIComponent(entry.photo_owner)}/avatar?account=${encodeURIComponent(account)}`
      : null);
  return {
    key: entry.key,
    label,
    // A number only appears when it is a real phone. A private identifier is
    // named by its last digits so two of them can be told apart.
    sublabel: phone && label !== phone ? phone : (entry.lid && label !== PRIVATE_LABEL ? `LID ···${lastDigits(entry.lid)}` : ''),
    kind: entry.has_chat ? 'chat' : (phone ? 'contact' : 'private'),
    chatId: entry.chat_id || null,
    phone,
    avatarUrl,
    source: entry.source,
    hasChat: entry.has_chat === true,
    archived: entry.chat_archived === true,
    // Opening an existing conversation stays local; starting a chat needs a
    // real number, and a LID cannot be dialled.
    canOpen: entry.has_chat === true,
    canStart: entry.has_chat !== true && Boolean(phone),
  };
}

function syncState(stats, { includeContacts }) {
  const savedNames = Number(stats.savedNames || 0);
  const unmappedLidChats = Number(stats.unmappedLidChats || 0);
  const notices = [
    'El directorio usa lo que esta cuenta ya sincronizó: chats, contactos vistos y participantes de grupos. WhatsApp no expone al completo la agenda del teléfono.',
    'Un identificador privado (@lid) no es un número de teléfono: sin número sincronizado, un contacto solo se abre si ya tiene chat.',
  ];
  if (!includeContacts) notices.push('La tabla de contactos del conector no está disponible en esta instalación: se usan chats y participantes.');
  if (!savedNames) notices.push('Ningún contacto tiene nombre guardado por el proveedor: la lista se ordena por nombre mostrado y número.');
  if (unmappedLidChats) notices.push(`${unmappedLidChats} chats usan un identificador privado sin número vinculado: pueden aparecer como dos entradas de la misma persona.`);
  return {
    identities: Number(stats.total || 0),
    matched: Number(stats.matched || 0),
    savedNames,
    unmappedLidChats,
    latestSyncAt: stats.latestSyncAt || null,
    sources: {
      contactIdentities: Number(stats.contactIdentities || 0),
      directChatIdentities: Number(stats.directChatIdentities || 0),
      groupMemberIdentities: Number(stats.groupMemberIdentities || 0),
    },
    connectorCatalog: {
      path: '/contacts',
      used: false,
      cap: 500,
      reason: 'El endpoint del conector corta en 500 contactos sin paginación y no identifica la cuenta que responde.',
    },
    notices,
  };
}

/**
 * One account-scoped directory page. `query` is the app's own database reader,
 * the one the chat list uses, so no provider call happens and another account's
 * identities cannot appear. The directory is a few thousand rows at most, so
 * the total is counted exactly rather than capped at one page.
 */
export async function readContactDirectory({ account, params, query, sendingEnabled = false }) {
  const options = contactDirectoryOptions(account, params);
  let includeContacts = true;
  let rows;
  let stats;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const shape = { includeContacts };
    const page = pageQuery(shape, account, options);
    const totals = statsQuery(shape, account, options);
    try {
      rows = await query(page.sql, page.args);
      stats = (await query(totals.sql, totals.args))[0] || {};
      break;
    } catch (error) {
      const missingContacts = error?.code === '42P01' || /whatsapp_contacts/.test(String(error?.message || ''));
      if (!includeContacts || !missingContacts) throw error;
      includeContacts = false;
    }
  }

  const contacts = rows.slice(0, options.limit);
  const last = contacts.at(-1);
  const hasMore = rows.length > options.limit;
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
    rank: Number(last.label_rank), sort: String(last.label_sort), key: String(last.key),
  })).toString('base64url') : null;

  return {
    account,
    query: options.q,
    sendingEnabled: sendingEnabled === true,
    total: Number(stats.matched || 0),
    limit: options.limit,
    hasMore,
    nextCursor,
    contacts: contacts.map(entry => publicEntry(entry, account)),
    sync: syncState(stats, { includeContacts }),
  };
}

export const CONTACT_DIRECTORY_DEFAULT_LIMIT = DEFAULT_PAGE_SIZE;
export const CONTACT_DIRECTORY_MAX_LIMIT = MAX_PAGE_SIZE;
export const CONTACT_DIRECTORY_PRIVATE_LABEL = PRIVATE_LABEL;
