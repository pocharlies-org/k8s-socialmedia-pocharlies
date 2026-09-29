-- 012 — WhatsApp chat state on conversations (fase 3 / PR-5): pin and mute,
-- next to the archived / unread_count columns that already exist.
--
-- Written by the whatsapp-web connector, on the CANONICAL conversation row
-- (account_id + external_id, merged_into IS NULL): for the actions of
-- POST /api/v1/chats/modify and for what the phone does (app-state
-- chats.update, history / chats.upsert snapshots). No separate chat-state
-- table: the NAS fork's whatsapp_chat_state duplicated conversations.
--
--   pinned_at  — NULL = not pinned; else when it was pinned (WhatsApp's own
--                pin time when it told us). WhatsApp orders pinned chats by it.
--   muted      — the chat is muted. With mute_until NULL that is "forever";
--   mute_until — with a time, muted until then. A timed mute is NOT cleared
--                when it expires: readers take
--                  muted AND (mute_until IS NULL OR mute_until > now())
--                as the effective state. No 'infinity' sentinel on purpose:
--                psycopg / asyncpg readers doing SELECT c.* cannot load it.
--
-- Archive and read state keep using archived / unread_count (the connector
-- already writes them from chats.update); a chat marked unread ("unread" mark
-- without a count) is unread_count >= 1.
--
-- EXPAND only, idempotent (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE).
-- The connector does NOT add these columns: while they are missing (42703)
-- pin / mute still go to WhatsApp, nothing is recorded for them, and archive /
-- read keep working as before. There is no CREATE TABLE here, so migrate.ts
-- never baselines this file: it runs once and is recorded.
--
-- ADD COLUMN with a constant default is catalog-only on PostgreSQL >= 11: no
-- table rewrite (2.6k conversations measured 29-09).

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned_at  TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS muted      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS mute_until TIMESTAMPTZ;

-- 011's body verbatim + the canonical conversation keeps a pin / mute its
-- alias (tombstone) had, like flagged: a PN twin pinned on the phone before
-- the merge stays pinned once it is folded into its @lid conversation. The
-- alias row keeps its own values, so social_unmerge_conversation (011, not
-- re-declared) hands them back untouched.
CREATE OR REPLACE FUNCTION social_merge_conversation(p_alias TEXT, p_canonical TEXT) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_msgs BIGINT[]; v_keys TEXT[]; a RECORD; c RECORD;
BEGIN
  SELECT * INTO a FROM conversations WHERE id = p_alias FOR UPDATE;
  SELECT * INTO c FROM conversations WHERE id = p_canonical FOR UPDATE;
  IF a.id IS NULL OR c.id IS NULL OR a.merged_into IS NOT NULL OR c.merged_into IS NOT NULL
     OR a.id = c.id OR a.account_id IS DISTINCT FROM c.account_id THEN
    RETURN 0;
  END IF;
  WITH u AS (UPDATE messages SET conversation_id = c.id WHERE conversation_id = a.id RETURNING id)
  SELECT COALESCE(array_agg(id), '{}') INTO v_msgs FROM u;
  WITH u AS (UPDATE whatsapp_message_keys SET conversation_id = c.id WHERE conversation_id = a.id
             RETURNING wa_message_id)
  SELECT COALESCE(array_agg(wa_message_id), '{}') INTO v_keys FROM u;
  UPDATE whatsapp_message_payloads SET conversation_id = c.id WHERE conversation_id = a.id;
  UPDATE whatsapp_message_reactions SET conversation_id = c.id WHERE conversation_id = a.id;
  UPDATE draft_replies SET conversation_id = c.id WHERE conversation_id = a.id;
  INSERT INTO conversation_participants (conversation_id, participant_id, role, joined_at)
  SELECT c.id, participant_id, role, joined_at FROM conversation_participants WHERE conversation_id = a.id
  ON CONFLICT DO NOTHING;
  DELETE FROM conversation_participants WHERE conversation_id = a.id;
  IF EXISTS (SELECT 1 FROM whatsapp_sync_state WHERE conversation_id = c.id) THEN
    DELETE FROM whatsapp_sync_state WHERE conversation_id = a.id;
  ELSE
    UPDATE whatsapp_sync_state SET conversation_id = c.id WHERE conversation_id = a.id;
  END IF;
  UPDATE conversations SET
      name = COALESCE(NULLIF(c.name, ''), a.name),
      last_message_at = GREATEST(COALESCE(c.last_message_at, a.last_message_at), COALESCE(a.last_message_at, c.last_message_at)),
      unread_count = COALESCE(c.unread_count, 0) + COALESCE(a.unread_count, 0),
      unread_mentions = COALESCE(c.unread_mentions, 0) + COALESCE(a.unread_mentions, 0),
      flagged = COALESCE(c.flagged, FALSE) OR COALESCE(a.flagged, FALSE),
      pinned_at = GREATEST(c.pinned_at, a.pinned_at),
      muted = COALESCE(c.muted, FALSE) OR COALESCE(a.muted, FALSE),
      mute_until = CASE
        WHEN (COALESCE(c.muted, FALSE) AND c.mute_until IS NULL)
          OR (COALESCE(a.muted, FALSE) AND a.mute_until IS NULL) THEN NULL
        ELSE GREATEST(CASE WHEN c.muted THEN c.mute_until END,
                      CASE WHEN a.muted THEN a.mute_until END)
      END,
      metadata = COALESCE(c.metadata, '{}'::jsonb)
        || jsonb_build_object('mergedAliases',
             COALESCE(c.metadata->'mergedAliases', '[]'::jsonb) || to_jsonb(a.external_id)),
      updated_at = NOW()
   WHERE id = c.id;
  UPDATE conversations SET merged_into = c.id, unread_count = 0, unread_mentions = 0, updated_at = NOW()
   WHERE id = a.id;
  INSERT INTO social_conversation_merges (alias_conversation_id, canonical_conversation_id, moved_message_ids, moved_key_ids)
  VALUES (a.id, c.id, v_msgs, v_keys);
  RETURN 1;
END $$;
