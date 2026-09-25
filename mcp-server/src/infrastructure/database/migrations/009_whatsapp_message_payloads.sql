-- 009 — Durable WhatsApp message payloads (fase 3 / PR-1, port of the NAS fork's
-- durable-message-store adapted to the multiaccount model of 008).
--
-- The whatsapp-web connector keeps the raw Baileys message (key + content) so
-- that quoting, forwarding and the Baileys retry callback (getMessage) keep
-- working after a restart; until now that copy lived only in process memory.
--
-- EXPAND only, idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF
-- EXISTS). The connector does NOT create this table: it fails soft (42P01 →
-- in-memory behaviour) while this file has not been applied yet.
--
-- Ids use the SAME namespacing as messages (accountKey in
-- connectors/whatsapp-web/src/db-writer.ts): wa_message_id joins to
-- messages.wa_message_id and conversation_id to conversations.id. No FK on
-- either on purpose: a send stores its payload before the echo creates the
-- messages row (and, on a first contact, the conversation).
--
-- NOTE for migrate.ts: the ledger baselines a file whose first table already
-- exists. whatsapp_message_payloads must not be created by hand before this runs,
-- or the triggers and the merge functions below would be skipped.

CREATE TABLE IF NOT EXISTS whatsapp_message_payloads (
  wa_message_id   TEXT PRIMARY KEY,              -- accountKey(<baileys key.id>)
  account         TEXT NOT NULL,                 -- legacy namespace (CONNECTOR_ACCOUNT)
  account_id      TEXT REFERENCES social_accounts(id),
  conversation_id TEXT NOT NULL,                 -- accountKey(<normalised chat jid>)
  message_key     JSONB NOT NULL,                -- WAMessageKey as received / sent
  message_payload JSONB NOT NULL,                -- proto.Message, thumbnails stripped, BufferJSON
  wa_timestamp    TIMESTAMPTZ,
  push_name       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_message_payloads_conversation
  ON whatsapp_message_payloads (conversation_id, wa_timestamp DESC);

-- account_id from (account, 'whatsapp') through the same helper the messages
-- trigger uses, so a payload row and its messages row always agree.
CREATE OR REPLACE FUNCTION social_fill_whatsapp_payload_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s RECORD;
BEGIN
  IF NEW.account_id IS NULL THEN
    s := social_split_legacy_id(NEW.wa_message_id, NEW.account, 'whatsapp');
    NEW.account_id := s.account_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_social_payload_keys ON whatsapp_message_payloads;
CREATE TRIGGER trg_social_payload_keys BEFORE INSERT
  ON whatsapp_message_payloads FOR EACH ROW EXECUTE FUNCTION social_fill_whatsapp_payload_keys();

-- Writes aimed at a merged (tombstone) conversation land on its canonical one.
DROP TRIGGER IF EXISTS trg_social_redirect ON whatsapp_message_payloads;
CREATE TRIGGER trg_social_redirect BEFORE INSERT OR UPDATE OF conversation_id
  ON whatsapp_message_payloads FOR EACH ROW EXECUTE FUNCTION social_redirect_merged_conversation();

-- 008's body verbatim + the payloads of the alias conversation move with its
-- messages.
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

-- 008's body verbatim + the payloads of the moved messages go back to the
-- alias. A payload with no messages row (send whose echo was never ingested)
-- stays on the canonical conversation, like any row written after the merge.
CREATE OR REPLACE FUNCTION social_unmerge_conversation(p_alias TEXT) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE l RECORD;
BEGIN
  SELECT * INTO l FROM social_conversation_merges WHERE alias_conversation_id = p_alias;
  IF l.id IS NULL THEN RETURN 0; END IF;
  UPDATE conversations SET merged_into = NULL, updated_at = NOW() WHERE id = p_alias;
  UPDATE messages SET conversation_id = p_alias WHERE id = ANY (l.moved_message_ids);
  UPDATE whatsapp_message_keys SET conversation_id = p_alias WHERE wa_message_id = ANY (l.moved_key_ids);
  UPDATE whatsapp_message_payloads SET conversation_id = p_alias
   WHERE wa_message_id IN (SELECT wa_message_id FROM messages WHERE id = ANY (l.moved_message_ids));
  -- Keep the alias row but block it, or the next periodic merge would redo it.
  UPDATE social_contact_aliases al SET evidence = 'blocked'
    FROM conversations c
   WHERE c.id = p_alias AND al.account_id = c.account_id AND al.alias_external_id = c.external_id;
  DELETE FROM social_conversation_merges WHERE id = l.id;
  RETURN 1;
END $$;
