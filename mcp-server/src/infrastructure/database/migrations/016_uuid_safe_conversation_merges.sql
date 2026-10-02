-- 016 - Preserve merge history for UUID and numeric message primary keys.
-- Migration 014 used BIGINT[] for moved message ids, while the NAS messages.id
-- column is UUID. TEXT[] holds either representation and permits lossless undo.
-- The NAS conversation table also predates these upstream merge fields.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unread_mentions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE social_conversation_merges ALTER COLUMN moved_message_ids DROP DEFAULT;
ALTER TABLE social_conversation_merges ALTER COLUMN moved_message_ids
  TYPE TEXT[] USING moved_message_ids::TEXT[];
ALTER TABLE social_conversation_merges ALTER COLUMN moved_message_ids
  SET DEFAULT '{}'::TEXT[];

CREATE OR REPLACE FUNCTION social_merge_conversation(p_alias TEXT, p_canonical TEXT) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_msgs TEXT[]; v_keys TEXT[]; a RECORD; c RECORD;
BEGIN
  SELECT * INTO a FROM conversations WHERE id = p_alias FOR UPDATE;
  SELECT * INTO c FROM conversations WHERE id = p_canonical FOR UPDATE;
  IF a.id IS NULL OR c.id IS NULL OR a.merged_into IS NOT NULL OR c.merged_into IS NOT NULL
     OR a.id = c.id OR a.account_id IS DISTINCT FROM c.account_id THEN
    RETURN 0;
  END IF;
  WITH u AS (UPDATE messages SET conversation_id = c.id WHERE conversation_id = a.id RETURNING id)
  SELECT COALESCE(array_agg(id::text), '{}') INTO v_msgs FROM u;
  WITH u AS (UPDATE whatsapp_message_keys SET conversation_id = c.id WHERE conversation_id = a.id
             RETURNING wa_message_id)
  SELECT COALESCE(array_agg(wa_message_id), '{}') INTO v_keys FROM u;
  UPDATE whatsapp_message_payloads SET conversation_id = c.id WHERE conversation_id = a.id;
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

-- Payloads of the moved messages go back to the alias. A payload without a
-- messages row (send whose echo was never ingested)
-- stays on the canonical conversation, like any row written after the merge.
CREATE OR REPLACE FUNCTION social_unmerge_conversation(p_alias TEXT) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE l RECORD;
BEGIN
  SELECT * INTO l FROM social_conversation_merges WHERE alias_conversation_id = p_alias;
  IF l.id IS NULL THEN RETURN 0; END IF;
  UPDATE conversations SET merged_into = NULL, updated_at = NOW() WHERE id = p_alias;
  UPDATE messages SET conversation_id = p_alias WHERE id::text = ANY (l.moved_message_ids);
  UPDATE whatsapp_message_keys SET conversation_id = p_alias WHERE wa_message_id = ANY (l.moved_key_ids);
  UPDATE whatsapp_message_payloads SET conversation_id = p_alias
   WHERE wa_message_id IN (SELECT wa_message_id FROM messages WHERE id::text = ANY (l.moved_message_ids));
  -- Keep the alias row but block it, or the next periodic merge would redo it.
  UPDATE social_contact_aliases al SET evidence = 'blocked'
    FROM conversations c
   WHERE c.id = p_alias AND al.account_id = c.account_id AND al.alias_external_id = c.external_id;
  DELETE FROM social_conversation_merges WHERE id = l.id;
  RETURN 1;
END $$;
