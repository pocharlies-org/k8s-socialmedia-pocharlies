-- 020 — WhatsApp 1:1 chats named after the account itself (QA audit 02-10-2026)
--
-- The connector linked the SENDER of every message to its chat in
-- conversation_participants, our own messages included. In a 1:1 chat our own
-- participant (e.g. professional:34628534490@c.us, push name "Skirmshop Spain")
-- became a "participant" of the chat, and dgx-messages names a 1:1 chat whose
-- stored name is only its jid after its best participant — a phone-jid row
-- ranks above the other side's @lid row, so almost every professional chat,
-- Dani's included, read "Skirmshop Spain". conversations.name was never
-- written with our name (it holds the jid). The connector no longer links us
-- in a direct chat (ingest-extras.ts linksSenderToChat); this file removes the
-- links already written.
--
-- Own identity = a sender of OUTBOUND rows in at least 10 distinct direct
-- chats of the account (measured 02-10: personal 34659695630@c.us in 239 and
-- 174869610295503@lid in 67, professional 34628534490@c.us in 91; every other
-- sender is in at most 2 — old rows with a wrong direction, which this file
-- must never touch). A link is removed only in a direct chat (not a group, a
-- status broadcast nor a channel) and only when that participant never sent an
-- INBOUND row there. ~220 rows on 02-10.
--
-- Nothing is lost: every removed row is kept in
-- conversation_participants_removed (with the reason). Revert:
--   INSERT INTO conversation_participants (conversation_id, participant_id, role, joined_at)
--   SELECT conversation_id, participant_id, role, joined_at
--     FROM conversation_participants_removed WHERE reason = 'own_identity_in_direct_chat'
--   ON CONFLICT DO NOTHING;
--
-- Also: the conversation `0@c.us` of an account is WhatsApp's own account
-- (0@s.whatsapp.net: WhatsApp Business welcome / announcement messages, 7 rows
-- in professional on 02-10). It is real, not garbage, so it stays; it is only
-- named "WhatsApp" instead of its jid (the connector names it so from now on).

CREATE TABLE IF NOT EXISTS conversation_participants_removed (
  conversation_id TEXT NOT NULL,
  participant_id  TEXT NOT NULL,
  role            TEXT,
  joined_at       TIMESTAMPTZ,
  removed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason          TEXT NOT NULL,
  PRIMARY KEY (conversation_id, participant_id)
);

WITH direct AS (
  SELECT c.id, c.account_id
    FROM conversations c
   WHERE c.account_id LIKE 'whatsapp:%'
     AND c.is_group IS NOT TRUE
     AND c.external_id ~ '@(lid|s\.whatsapp\.net|c\.us)$'
), own AS (
  SELECT m.account_id, m.sender_wa_id AS participant_id
    FROM messages m
    JOIN direct d ON d.id = m.conversation_id
   WHERE m.platform = 'whatsapp'
     AND m.direction = 'OUTBOUND'
     AND m.sender_wa_id IS NOT NULL
   GROUP BY m.account_id, m.sender_wa_id
  HAVING count(DISTINCT m.conversation_id) >= 10
), doomed AS (
  SELECT cp.conversation_id, cp.participant_id, cp.role, cp.joined_at
    FROM conversation_participants cp
    JOIN direct d ON d.id = cp.conversation_id
    JOIN own o ON o.account_id = d.account_id AND o.participant_id = cp.participant_id
   WHERE NOT EXISTS (
           SELECT 1
             FROM messages m
            WHERE m.conversation_id = cp.conversation_id
              AND m.direction = 'INBOUND'
              AND m.sender_wa_id = cp.participant_id
         )
), saved AS (
  INSERT INTO conversation_participants_removed
         (conversation_id, participant_id, role, joined_at, reason)
  SELECT conversation_id, participant_id, role, joined_at, 'own_identity_in_direct_chat'
    FROM doomed
  ON CONFLICT (conversation_id, participant_id) DO NOTHING
  RETURNING conversation_id, participant_id
)
DELETE FROM conversation_participants cp
 USING doomed d
 WHERE cp.conversation_id = d.conversation_id
   AND cp.participant_id = d.participant_id;

UPDATE conversations
   SET name = 'WhatsApp'
 WHERE account_id LIKE 'whatsapp:%'
   AND external_id IN ('0@c.us', '0@s.whatsapp.net')
   AND (name IS NULL OR name = '' OR name = '0' OR name LIKE '%@%');

UPDATE participants
   SET name = 'WhatsApp'
 WHERE account_id LIKE 'whatsapp:%'
   AND external_id IN ('0@c.us', '0@s.whatsapp.net')
   AND (name IS NULL OR name = '' OR name = '0' OR name LIKE '%@%');
