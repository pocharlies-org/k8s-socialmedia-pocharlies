-- 011 — WhatsApp message reactions (fase 3 / PR-4, port of the NAS fork's
-- whatsapp_message_reactions adapted to the multiaccount model of 008).
--
-- Until now a reaction reached the DB only as a messages INSERT with
-- message_type 'REACTION' (body = emoji, reply_to_message_id = target) that the
-- BEFORE INSERT trigger trg_merge_inbound_reaction (merge_inbound_reaction(),
-- present in prod but not in this repo) folds into the target's
-- messages.reactions JSONB and then skips: 0 REACTION rows exist (measured
-- 29-09) and the JSONB is what dgx-messages shows. That path is untouched —
-- the connector keeps ingesting the REACTION messages exactly as before.
--
-- This table is the queryable record next to it: ONE current reaction per
-- (account, target message, reactor). Changing the emoji updates the row;
-- removing it sets removed = true and keeps the last emoji (nothing is
-- deleted). Written by the whatsapp-web connector for inbound reactions,
-- reactions from our own phone and the ones it sends. Readers use the view
-- whatsapp_message_reactions_current below.
--
-- EXPAND only, idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF
-- EXISTS). The connector does NOT create this table: while it is missing
-- (42P01) reactions keep going to messages.reactions only, and sending one
-- still works.
--
-- Ids use the SAME namespacing as messages (accountKey in
-- connectors/whatsapp-web/src/db-writer.ts): target_wa_message_id joins to
-- messages.wa_message_id, conversation_id to conversations.id and reactor_jid
-- to participants.id / messages.sender_wa_id. No FK on purpose: a reaction can
-- arrive before (or without) its target message.
--
-- No backfill: there are no REACTION rows to take it from. The history lives
-- in messages.reactions (13k WhatsApp messages, reactors as participant ids
-- or "me"); copying it here is a follow-up, not part of this migration.
--
-- NOTE for migrate.ts: the ledger baselines a file whose first table already
-- exists. whatsapp_message_reactions must not be created by hand before this
-- runs, or the triggers, the view and the merge functions below would be
-- skipped.

CREATE TABLE IF NOT EXISTS whatsapp_message_reactions (
  account                TEXT NOT NULL,          -- legacy namespace (CONNECTOR_ACCOUNT)
  account_id             TEXT REFERENCES social_accounts(id),
  target_wa_message_id   TEXT NOT NULL,          -- accountKey(<id of the reacted message>)
  reactor_jid            TEXT NOT NULL,          -- accountKey(<normalised jid>), LID when an alias says so
  reactor_seen_jid       TEXT,                   -- the jid the last reaction carried (before the alias)
  conversation_id        TEXT NOT NULL,          -- accountKey(<normalised chat jid>)
  reaction_wa_message_id TEXT,                   -- accountKey(<id of the reaction message>)
  emoji                  TEXT,                   -- current emoji; kept as the last one when removed
  removed                BOOLEAN NOT NULL DEFAULT FALSE,
  from_me                BOOLEAN,                -- this account reacted; NULL = the key never said
  reacted_at             TIMESTAMPTZ,            -- WhatsApp time of the reaction (senderTimestampMs)
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, target_wa_message_id, reactor_jid)
);

-- "Reactions of message X" by id alone (namespaced ids are unique across
-- accounts, as in messages): dgx-messages and the MCP know the target, not
-- always the account. The PK serves the connector's (account, target) upsert.
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_reactions_target
  ON whatsapp_message_reactions (target_wa_message_id);

-- "Reactions in conversation", newest first.
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_reactions_conversation
  ON whatsapp_message_reactions (conversation_id, updated_at DESC);

-- account_id from (account, 'whatsapp') through the same helper the messages
-- trigger uses. The reactor is filed under its canonical identity: a phone
-- jid (@c.us / @s.whatsapp.net) whose social_contact_aliases rows point at ONE
-- @lid becomes that LID, so the same person reacting as PN and as LID keeps
-- ONE current reaction (the upsert conflicts on the canonical PK). Nothing is
-- collapsed when either phone form is blocked (an unmerged pair) or the
-- aliases disagree.
CREATE OR REPLACE FUNCTION social_whatsapp_reactor_lid(p_account_id TEXT, p_jid TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN bool_or(a.evidence = 'blocked') OR count(DISTINCT a.canonical_external_id) <> 1
              THEN NULL ELSE min(a.canonical_external_id) END
    FROM social_contact_aliases a
   WHERE p_jid ~ '@(c\.us|s\.whatsapp\.net)$'
     AND a.account_id = p_account_id
     AND a.alias_external_id IN (replace(p_jid, '@s.whatsapp.net', '@c.us'),
                                 replace(p_jid, '@c.us', '@s.whatsapp.net'))
     AND a.canonical_external_id LIKE '%@lid'
$$;

-- The conversation is the target message's when that row exists (a PN- and a
-- LID-addressed reaction to the same message land together); otherwise the
-- chat the reaction came in.
CREATE OR REPLACE FUNCTION social_fill_whatsapp_reaction_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s RECORD; r RECORD; v_canon TEXT; v_conv TEXT;
BEGIN
  IF NEW.account_id IS NULL THEN
    s := social_split_legacy_id(NEW.target_wa_message_id, NEW.account, 'whatsapp');
    NEW.account_id := s.account_id;
  END IF;
  SELECT m.conversation_id INTO v_conv FROM messages m WHERE m.wa_message_id = NEW.target_wa_message_id;
  NEW.conversation_id := COALESCE(v_conv, NEW.conversation_id);
  NEW.reactor_seen_jid := COALESCE(NEW.reactor_seen_jid, NEW.reactor_jid);
  r := social_split_legacy_id(NEW.reactor_jid, NEW.account, 'whatsapp');
  v_canon := social_whatsapp_reactor_lid(NEW.account_id, r.external_id);
  IF v_canon IS NOT NULL THEN
    -- keep the namespace prefix the writer used (none for personal)
    NEW.reactor_jid := left(NEW.reactor_jid, length(NEW.reactor_jid) - length(r.external_id))
                       || v_canon;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_social_reaction_keys ON whatsapp_message_reactions;
CREATE TRIGGER trg_social_reaction_keys BEFORE INSERT
  ON whatsapp_message_reactions FOR EACH ROW EXECUTE FUNCTION social_fill_whatsapp_reaction_keys();

-- Writes aimed at a merged (tombstone) conversation land on its canonical one.
DROP TRIGGER IF EXISTS trg_social_redirect ON whatsapp_message_reactions;
CREATE TRIGGER trg_social_redirect BEFORE INSERT OR UPDATE OF conversation_id
  ON whatsapp_message_reactions FOR EACH ROW EXECUTE FUNCTION social_redirect_merged_conversation();

-- Current reactions: the latest state per (conversation, target, person),
-- removed ones left out. The person is the canonical reactor again at read
-- time, so a PN row and a LID row written before their alias existed count
-- once (the newest wins). Filter by target_wa_message_id or conversation_id
-- (both are DISTINCT ON keys, so the filter reaches the indexes above; a
-- target's rows share its conversation, see the trigger).
CREATE OR REPLACE VIEW whatsapp_message_reactions_current AS
SELECT account, account_id, target_wa_message_id, conversation_id, reactor_jid,
       emoji, from_me, reacted_at, updated_at
  FROM (
    SELECT DISTINCT ON (r.conversation_id, r.target_wa_message_id, p.person)
           r.account, r.account_id, r.target_wa_message_id, r.conversation_id, r.reactor_jid,
           r.emoji, r.removed, r.from_me, r.reacted_at, r.updated_at
      FROM whatsapp_message_reactions r
      CROSS JOIN LATERAL (SELECT regexp_replace(r.reactor_jid, '^[a-z][a-z0-9_-]*:', '') AS bare) x
      CROSS JOIN LATERAL (
        SELECT COALESCE(social_whatsapp_reactor_lid(r.account_id, x.bare), x.bare) AS person) p
     ORDER BY r.conversation_id, r.target_wa_message_id, p.person,
              r.reacted_at DESC NULLS LAST, r.updated_at DESC
  ) latest
 WHERE NOT removed;

-- 009's body verbatim + the reactions of the alias conversation move with its
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

-- 009's body verbatim + the reactions to the moved messages go back to the
-- alias. A reaction whose target has no messages row stays on the canonical
-- conversation, like 009's payloads and any row written after the merge.
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
  UPDATE whatsapp_message_reactions SET conversation_id = p_alias
   WHERE target_wa_message_id IN (SELECT wa_message_id FROM messages WHERE id = ANY (l.moved_message_ids));
  -- Keep the alias row but block it, or the next periodic merge would redo it.
  UPDATE social_contact_aliases al SET evidence = 'blocked'
    FROM conversations c
   WHERE c.id = p_alias AND al.account_id = c.account_id AND al.alias_external_id = c.external_id;
  DELETE FROM social_conversation_merges WHERE id = l.id;
  RETURN 1;
END $$;
