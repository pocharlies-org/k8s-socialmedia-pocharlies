const JID_SUFFIX = /@(lid|c\.us|s\.whatsapp\.net|g\.us|broadcast|newsletter)$/;
export const MESSAGE_VISIBLE_SQL = "m.message_type NOT IN ('SENDERKEYDISTRIBUTIONMESSAGE', 'MESSAGECONTEXTINFO', 'POLL_VOTE', 'POLL_RESULT', 'REACTION')";

export const MESSAGE_REPLY_SELECT_SQL = `
       reply.message_type AS "replyType",
       reply.content AS "replyText",
       CASE WHEN reply.direction = 'OUTBOUND' THEN 'Tú'
            ELSE COALESCE(
              CASE WHEN reply_sender.name IS NOT NULL AND BTRIM(reply_sender.name) <> ''
                AND reply_sender.name !~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us)$'
                AND reply_sender.name <> reply_sender.id THEN BTRIM(reply_sender.name) END,
              CASE WHEN reply_sender.push_name IS NOT NULL AND BTRIM(reply_sender.push_name) <> ''
                AND reply_sender.push_name !~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us)$'
                AND reply_sender.push_name <> reply_sender.id THEN BTRIM(reply_sender.push_name) END,
              CASE WHEN reply.sender_wa_id ~ '(?:^|:)\\d{6,15}@(c\\.us|s\\.whatsapp\\.net)$'
                THEN '+' || substring(reply.sender_wa_id FROM '(?:^|:)(\\d{6,15})@')
                ELSE regexp_replace(reply.sender_wa_id, '^[^:]+:', '') END
            ) END AS "replySenderName",
       reply.id IS NOT NULL AS "replyAvailable"`;

export const MESSAGE_REPLY_JOIN_SQL = `
LEFT JOIN LATERAL (
  SELECT target.id, target.content, target.message_type, target.direction, target.sender_wa_id
  FROM messages target
  WHERE target.account = m.account
    AND target.conversation_id = ANY($2::text[])
    AND target.platform = 'whatsapp'
    AND NOT target.is_deleted
    AND target.message_type NOT IN ('SENDERKEYDISTRIBUTIONMESSAGE', 'MESSAGECONTEXTINFO', 'POLL_VOTE', 'POLL_RESULT', 'REACTION')
    AND target.wa_message_id IN (
      m.reply_to_message_id,
      m.account || ':' || m.reply_to_message_id,
      regexp_replace(m.reply_to_message_id, '^[^:]+:', '')
    )
  ORDER BY (target.conversation_id = m.conversation_id) DESC, target.wa_timestamp DESC
  LIMIT 1
) reply ON m.reply_to_message_id IS NOT NULL
LEFT JOIN participants reply_sender
  ON reply_sender.id = reply.sender_wa_id AND reply_sender.account = m.account`;

/** A database value is a placeholder when it is just a provider identifier. */
export function isJidPlaceholder(value, id = '') {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return true;
  const identifier = typeof id === 'string' ? id.trim() : '';
  const bareIdentifier = identifier.replace(/^[^:]+:/, '');
  return name === identifier || name === bareIdentifier || JID_SUFFIX.test(name);
}

function useful(value, id) {
  return typeof value === 'string' && value.trim() && !isJidPlaceholder(value, id)
    ? value.trim()
    : null;
}

/**
 * Resolve a chat title from stored values. Participant names are only a
 * fallback for direct chats; a group must keep its own subject.
 */
export function resolveChatName({
  id,
  isGroup = false,
  conversationName,
  contactName,
  pushName,
}) {
  const identifier = typeof id === 'string' ? id : '';
  const fallbackId = identifier.replace(/^[^:]+:/, '');
  const candidates = isGroup
    ? [conversationName, fallbackId]
    : [conversationName, contactName, pushName, fallbackId];
  return candidates.map(value => useful(value, identifier)).find(Boolean) || fallbackId;
}

/** Pick the sender label used for an inbound message row. */
export function resolveMessageSenderName({ fromMe = false, senderName, senderPushName, senderId }) {
  if (fromMe) return null;
  return useful(senderName, senderId) || useful(senderPushName, senderId) || senderId || null;
}

export function readableChatName(chat) {
  if (chat.isGroup || !isJidPlaceholder(chat.name, chat.id)) return chat.name;
  for (const id of [chat.waChatId, chat.id]) {
    const bare = String(id || '').replace(/^[^:]+:/, '');
    const match = bare.match(/^(\d{6,15})@(?:c\.us|s\.whatsapp\.net)$/);
    if (match) return `+${match[1]}`;
  }
  return chat.name;
}

/**
 * The app's chat list query. `$1` is always the selected account. The
 * inbound sender fallback repairs old direct chats whose stored title is a
 * JID, while the group branch never promotes a participant to group title.
 */
const CHAT_LIST_BASE_SQL = `
SELECT c.id,
       c.wa_chat_id AS "waChatId",
       CASE
         WHEN COALESCE(c.is_group, false) THEN COALESCE(
           CASE
             WHEN c.name IS NULL OR BTRIM(c.name) = '' OR c.name = c.id
               OR c.name = regexp_replace(c.id, '^[^:]+:', '')
               OR c.name ~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$'
             THEN NULL
             ELSE c.name
           END,
           regexp_replace(c.id, '^[^:]+:', '')
         )
         WHEN c.name IS NOT NULL
          AND BTRIM(c.name) <> ''
          AND c.name <> c.id
          AND c.name <> regexp_replace(c.id, '^[^:]+:', '')
          AND c.name !~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$'
           THEN c.name
        ELSE COALESCE(
           CASE
             WHEN pn_alias.name IS NULL OR BTRIM(pn_alias.name) = ''
               OR pn_alias.name = ANY(pn_alias.ids)
               OR pn_alias.name ~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$'
             THEN NULL
             ELSE BTRIM(pn_alias.name)
           END,
           CASE
             WHEN inbound.sender_name IS NULL
               OR BTRIM(inbound.sender_name) = ''
               OR inbound.sender_name = inbound.sender_id
               OR inbound.sender_name = regexp_replace(inbound.sender_id, '^[^:]+:', '')
               OR inbound.sender_name ~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$'
             THEN NULL
             ELSE BTRIM(inbound.sender_name)
           END,
           CASE
             WHEN inbound.push_name IS NULL
               OR BTRIM(inbound.push_name) = ''
               OR inbound.push_name = inbound.sender_id
               OR inbound.push_name = regexp_replace(inbound.sender_id, '^[^:]+:', '')
               OR inbound.push_name ~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$'
             THEN NULL
             ELSE BTRIM(inbound.push_name)
           END,
           CASE
             WHEN c.name IS NULL OR BTRIM(c.name) = '' OR c.name = c.id
               OR c.name = regexp_replace(c.id, '^[^:]+:', '')
               OR c.name ~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$'
             THEN NULL
             ELSE BTRIM(c.name)
           END,
           regexp_replace(c.id, '^[^:]+:', '')
         )
       END AS name,
       COALESCE(last_message.content, '') AS preview,
       COALESCE(c.unread_count, 0) + COALESCE(pn_alias.unread_count, 0) AS unread,
       COALESCE(c.is_group, false) AS "isGroup",
       (COALESCE(c.archived, false) OR COALESCE(pn_alias.archived, false)) AS archived,
       COALESCE(c.avatar_url, pn_alias.avatar_url) AS "avatarUrl",
       last_message.wa_timestamp AS timestamp,
       last_message.direction = 'OUTBOUND' AS "fromMe"
FROM conversations c
LEFT JOIN LATERAL (
  SELECT array_agg(pn.id ORDER BY pn.id) AS ids,
         (array_agg(pn.name ORDER BY
           (pn.name IS NULL OR BTRIM(pn.name) = ''
             OR pn.name ~ '@(lid|c\\.us|s\\.whatsapp\\.net)$'), pn.id))[1] AS name,
         (array_agg(pn.avatar_url ORDER BY (pn.avatar_url IS NULL), pn.id))[1] AS avatar_url,
         COALESCE(SUM(COALESCE(pn.unread_count, 0)), 0)::integer AS unread_count,
         BOOL_OR(COALESCE(pn.archived, false)) AS archived
  FROM conversations pn
  WHERE c.id ~ '@lid$'
    AND COALESCE(c.is_group, false) = false
    AND pn.account = c.account
    AND COALESCE(pn.is_group, false) = false
    AND pn.id ~ '[0-9]+@(c\\.us|s\\.whatsapp\\.net)$'
    AND regexp_replace(pn.id, '@c\\.us$', '@s.whatsapp.net') =
        regexp_replace(c.wa_chat_id, '@c\\.us$', '@s.whatsapp.net')
    AND (SELECT COUNT(*) FROM conversations other_lid
         WHERE other_lid.account = c.account
           AND COALESCE(other_lid.is_group, false) = false
           AND other_lid.id ~ '@lid$'
           AND regexp_replace(other_lid.wa_chat_id, '@c\\.us$', '@s.whatsapp.net') =
               regexp_replace(c.wa_chat_id, '@c\\.us$', '@s.whatsapp.net')) = 1
) pn_alias ON true
LEFT JOIN LATERAL (
  SELECT m.content, m.wa_timestamp, m.direction
  FROM messages m
  WHERE m.conversation_id = ANY(array_prepend(c.id, COALESCE(pn_alias.ids, ARRAY[]::text[])))
    AND m.account = $1
    AND m.platform = 'whatsapp'
    AND NOT m.is_deleted
    AND ${MESSAGE_VISIBLE_SQL}
  ORDER BY m.wa_timestamp DESC
  LIMIT 1
) last_message ON true
LEFT JOIN LATERAL (
  SELECT p.id AS sender_id, p.name AS sender_name, p.push_name
  FROM messages m
  LEFT JOIN participants p
    ON p.id = m.sender_wa_id
   AND p.account = m.account
  WHERE m.conversation_id = ANY(array_prepend(c.id, COALESCE(pn_alias.ids, ARRAY[]::text[])))
    AND m.account = $1
    AND m.platform = 'whatsapp'
    AND NOT m.is_deleted
    AND ${MESSAGE_VISIBLE_SQL}
    AND m.direction = 'INBOUND'
  ORDER BY (
    (p.name IS NOT NULL AND BTRIM(p.name) <> ''
      AND p.name !~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$')
    OR (p.push_name IS NOT NULL AND BTRIM(p.push_name) <> ''
      AND p.push_name !~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$')
  ) DESC,
  m.wa_timestamp DESC
  LIMIT 1
) inbound ON true
WHERE c.account = $1
  AND c.id !~ '@newsletter$'
  AND c.id !~ '(^|:)status@broadcast$'
  AND NOT (
    COALESCE(c.is_group, false) = false
    AND c.id ~ '[0-9]+@(c\\.us|s\\.whatsapp\\.net)$'
    AND (SELECT COUNT(*) FROM conversations lid
         WHERE lid.account = c.account AND COALESCE(lid.is_group, false) = false
           AND lid.id ~ '@lid$'
           AND regexp_replace(lid.wa_chat_id, '@c\\.us$', '@s.whatsapp.net') =
               regexp_replace(c.id, '@c\\.us$', '@s.whatsapp.net')) = 1
  )`;

const CHAT_LIST_ORDER_SQL = 'ORDER BY COALESCE(last_message.wa_timestamp, c.last_message_at) DESC NULLS LAST';
export const CHAT_LIST_SQL = `${CHAT_LIST_BASE_SQL}\n${CHAT_LIST_ORDER_SQL}\nLIMIT 500`;
export const CHAT_LIST_ACTIVE_SQL = `${CHAT_LIST_BASE_SQL}
AND (COALESCE(c.archived, false) OR COALESCE(pn_alias.archived, false)) = false
${CHAT_LIST_ORDER_SQL}
LIMIT 500`;
export const CHAT_LIST_ARCHIVED_SQL = `${CHAT_LIST_BASE_SQL}
AND (COALESCE(c.archived, false) OR COALESCE(pn_alias.archived, false)) = true
${CHAT_LIST_ORDER_SQL}`;

/** Query used by the app server before it maps attachment rows. */
export const MESSAGE_LIST_BASE_SQL = `
SELECT m.id,
       m.wa_message_id AS "waMessageId",
       m.content AS text,
       m.message_type AS type,
       m.metadata,
       m.reply_to_message_id AS "replyToMessageId",
       COALESCE(m.is_edited, false) AS "isEdited",
       m.direction = 'OUTBOUND' AS "fromMe",
       m.wa_timestamp AS timestamp,
       ${MESSAGE_REPLY_SELECT_SQL},
       CASE WHEN m.direction = 'OUTBOUND' THEN NULL
            ELSE COALESCE(
              CASE
                WHEN p.name IS NULL OR BTRIM(p.name) = '' OR p.name = p.id
                  OR p.name = regexp_replace(p.id, '^[^:]+:', '')
                  OR p.name ~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$'
                THEN NULL
                ELSE BTRIM(p.name)
              END,
              CASE
                WHEN p.push_name IS NULL OR BTRIM(p.push_name) = '' OR p.push_name = p.id
                  OR p.push_name = regexp_replace(p.id, '^[^:]+:', '')
                  OR p.push_name ~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$'
                THEN NULL
                ELSE BTRIM(p.push_name)
              END
            )
       END AS "senderName"
FROM messages m
LEFT JOIN participants p
  ON p.id = m.sender_wa_id
 AND p.account = m.account
${MESSAGE_REPLY_JOIN_SQL}
WHERE m.account = $1
  AND m.conversation_id = ANY($2::text[])
  AND m.platform = 'whatsapp'
  AND NOT m.is_deleted
  AND ${MESSAGE_VISIBLE_SQL}`;
export const MESSAGE_LIST_SQL = `${MESSAGE_LIST_BASE_SQL}
ORDER BY m.wa_timestamp DESC, m.id DESC
LIMIT 200`;
