-- 013 — WhatsApp poll votes and event responses (fase 3 / PR-7, port of the
-- NAS fork's polls / events adapted to the multiaccount model of 008 and to
-- the per-person state table of 011).
--
-- Until now the connector had no poll / event handling: a vote arrived as an
-- empty messages row (message_type POLLUPDATEMESSAGE, 296 rows measured
-- 30-09, all undecryptable without the poll's secret), a poll as an empty
-- MESSAGECONTEXTINFO / POLLCREATIONMESSAGEV3 row. From PR-7 the connector
-- writes a poll / event as a proper row (message_type POLL / EVENT, content =
-- question / name, metadata.poll / metadata.event), keeps its secret in
-- whatsapp_message_payloads (009) and decrypts every vote / response into the
-- tables below instead of writing a messages row. The old rows are left as
-- they are.
--
-- ONE current state per (account, poll/event message, person):
--   whatsapp_poll_votes      — the options of the latest vote; an empty vote
--                              (retract) sets retracted = true and keeps the
--                              last selection;
--   whatsapp_event_responses — going / not_going / maybe of the latest
--                              response ('unknown' = the answer was cleared).
-- Nothing is deleted. An older update (history sync) never overwrites a newer
-- one: the connector's upsert only applies when its WhatsApp time
-- (voted_at / responded_at) is not older. Readers use the *_current views.
--
-- EXPAND only, idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF
-- EXISTS). The connector does NOT create these tables: while they are missing
-- (42P01) votes / responses are not recorded and sending still works.
--
-- Ids use the SAME namespacing as messages (accountKey in
-- connectors/whatsapp-web/src/db-writer.ts): poll_wa_message_id /
-- event_wa_message_id join to messages.wa_message_id, conversation_id to
-- conversations.id, voter_jid / responder_jid to participants.id. No FK on
-- purpose: a vote can arrive before (or without) the poll's row.
--
-- NOTE for migrate.ts: the ledger baselines a file whose first table already
-- exists. whatsapp_poll_votes must not be created by hand before this runs,
-- or everything below would be skipped.

CREATE TABLE IF NOT EXISTS whatsapp_poll_votes (
  account             TEXT NOT NULL,          -- legacy namespace (CONNECTOR_ACCOUNT)
  account_id          TEXT REFERENCES social_accounts(id),
  poll_wa_message_id  TEXT NOT NULL,          -- accountKey(<id of the poll creation message>)
  voter_jid           TEXT NOT NULL,          -- accountKey(<normalised jid>), LID when an alias says so
  voter_seen_jid      TEXT,                   -- the jid the last vote carried (before the alias)
  conversation_id     TEXT NOT NULL,          -- accountKey(<normalised chat jid>)
  vote_wa_message_id  TEXT,                   -- accountKey(<id of the pollUpdateMessage>)
  selected_options    TEXT[] NOT NULL DEFAULT '{}',  -- option names; the last ones when retracted
  selected_hashes     TEXT[] NOT NULL DEFAULT '{}',  -- hex SHA-256 as the vote carried them
  retracted           BOOLEAN NOT NULL DEFAULT FALSE,
  from_me             BOOLEAN,                -- this account voted; NULL = the key never said
  voted_at            TIMESTAMPTZ,            -- WhatsApp time of the vote (senderTimestampMs)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, poll_wa_message_id, voter_jid)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_poll_votes_poll
  ON whatsapp_poll_votes (poll_wa_message_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_poll_votes_conversation
  ON whatsapp_poll_votes (conversation_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_event_responses (
  account                 TEXT NOT NULL,
  account_id              TEXT REFERENCES social_accounts(id),
  event_wa_message_id     TEXT NOT NULL,      -- accountKey(<id of the event message>)
  responder_jid           TEXT NOT NULL,      -- accountKey(<normalised jid>), LID when an alias says so
  responder_seen_jid      TEXT,
  conversation_id         TEXT NOT NULL,
  response_wa_message_id  TEXT,               -- accountKey(<id of the encEventResponseMessage>)
  response                TEXT NOT NULL
                          CHECK (response IN ('going', 'not_going', 'maybe', 'unknown')),
  extra_guest_count       INTEGER NOT NULL DEFAULT 0 CHECK (extra_guest_count >= 0),
  from_me                 BOOLEAN,
  responded_at            TIMESTAMPTZ,        -- WhatsApp time of the response (timestampMs)
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, event_wa_message_id, responder_jid)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_event_responses_event
  ON whatsapp_event_responses (event_wa_message_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_event_responses_conversation
  ON whatsapp_event_responses (conversation_id, updated_at DESC);

-- account_id, conversation and canonical person, as 011 does for reactions:
-- account_id from (account, 'whatsapp'); the conversation is the poll's /
-- event's row when it exists (a PN- and a LID-addressed vote land together);
-- a phone jid voter whose social_contact_aliases point at ONE @lid is filed
-- under that LID (social_whatsapp_reactor_lid of 011), so the same person
-- voting as PN and as LID keeps ONE current vote. Blocked / ambiguous aliases
-- collapse nothing.
CREATE OR REPLACE FUNCTION social_fill_whatsapp_poll_vote_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s RECORD; r RECORD; v_canon TEXT; v_conv TEXT;
BEGIN
  IF NEW.account_id IS NULL THEN
    s := social_split_legacy_id(NEW.poll_wa_message_id, NEW.account, 'whatsapp');
    NEW.account_id := s.account_id;
  END IF;
  SELECT m.conversation_id INTO v_conv FROM messages m WHERE m.wa_message_id = NEW.poll_wa_message_id;
  NEW.conversation_id := COALESCE(v_conv, NEW.conversation_id);
  NEW.voter_seen_jid := COALESCE(NEW.voter_seen_jid, NEW.voter_jid);
  r := social_split_legacy_id(NEW.voter_jid, NEW.account, 'whatsapp');
  v_canon := social_whatsapp_reactor_lid(NEW.account_id, r.external_id);
  IF v_canon IS NOT NULL THEN
    NEW.voter_jid := left(NEW.voter_jid, length(NEW.voter_jid) - length(r.external_id)) || v_canon;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION social_fill_whatsapp_event_response_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s RECORD; r RECORD; v_canon TEXT; v_conv TEXT;
BEGIN
  IF NEW.account_id IS NULL THEN
    s := social_split_legacy_id(NEW.event_wa_message_id, NEW.account, 'whatsapp');
    NEW.account_id := s.account_id;
  END IF;
  SELECT m.conversation_id INTO v_conv FROM messages m WHERE m.wa_message_id = NEW.event_wa_message_id;
  NEW.conversation_id := COALESCE(v_conv, NEW.conversation_id);
  NEW.responder_seen_jid := COALESCE(NEW.responder_seen_jid, NEW.responder_jid);
  r := social_split_legacy_id(NEW.responder_jid, NEW.account, 'whatsapp');
  v_canon := social_whatsapp_reactor_lid(NEW.account_id, r.external_id);
  IF v_canon IS NOT NULL THEN
    NEW.responder_jid := left(NEW.responder_jid, length(NEW.responder_jid) - length(r.external_id)) || v_canon;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_social_poll_vote_keys ON whatsapp_poll_votes;
CREATE TRIGGER trg_social_poll_vote_keys BEFORE INSERT
  ON whatsapp_poll_votes FOR EACH ROW EXECUTE FUNCTION social_fill_whatsapp_poll_vote_keys();

DROP TRIGGER IF EXISTS trg_social_event_response_keys ON whatsapp_event_responses;
CREATE TRIGGER trg_social_event_response_keys BEFORE INSERT
  ON whatsapp_event_responses FOR EACH ROW EXECUTE FUNCTION social_fill_whatsapp_event_response_keys();

-- Writes aimed at a merged (tombstone) conversation land on its canonical one.
DROP TRIGGER IF EXISTS trg_social_redirect ON whatsapp_poll_votes;
CREATE TRIGGER trg_social_redirect BEFORE INSERT OR UPDATE OF conversation_id
  ON whatsapp_poll_votes FOR EACH ROW EXECUTE FUNCTION social_redirect_merged_conversation();

DROP TRIGGER IF EXISTS trg_social_redirect ON whatsapp_event_responses;
CREATE TRIGGER trg_social_redirect BEFORE INSERT OR UPDATE OF conversation_id
  ON whatsapp_event_responses FOR EACH ROW EXECUTE FUNCTION social_redirect_merged_conversation();

-- The /messages SSE refreshes a poll / event when its votes change: the same
-- 'message_updated' channel (payload {id, conversation_id, kind}) that
-- merge_inbound_reaction and dgx-messages use. Nothing when the poll has no
-- messages row yet.
CREATE OR REPLACE FUNCTION social_notify_whatsapp_response() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_target TEXT; v_id BIGINT; v_kind TEXT;
BEGIN
  IF TG_TABLE_NAME = 'whatsapp_poll_votes' THEN
    v_target := NEW.poll_wa_message_id; v_kind := 'poll';
  ELSE
    v_target := NEW.event_wa_message_id; v_kind := 'event';
  END IF;
  SELECT m.id INTO v_id FROM messages m WHERE m.wa_message_id = v_target;
  IF v_id IS NOT NULL THEN
    PERFORM pg_notify('message_updated', json_build_object(
      'id', v_id, 'conversation_id', NEW.conversation_id, 'kind', v_kind)::text);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_social_notify_response ON whatsapp_poll_votes;
CREATE TRIGGER trg_social_notify_response AFTER INSERT OR UPDATE
  ON whatsapp_poll_votes FOR EACH ROW EXECUTE FUNCTION social_notify_whatsapp_response();

DROP TRIGGER IF EXISTS trg_social_notify_response ON whatsapp_event_responses;
CREATE TRIGGER trg_social_notify_response AFTER INSERT OR UPDATE
  ON whatsapp_event_responses FOR EACH ROW EXECUTE FUNCTION social_notify_whatsapp_response();

-- Current votes: the latest state per (conversation, poll, person), retracted
-- ones left out. The person is the canonical voter again at read time, so a
-- PN row and a LID row written before their alias existed count once (the
-- newest wins). Filter by poll_wa_message_id or conversation_id (DISTINCT ON
-- keys, so the filter reaches the indexes above).
CREATE OR REPLACE VIEW whatsapp_poll_votes_current AS
SELECT account, account_id, poll_wa_message_id, conversation_id, voter_jid,
       selected_options, selected_hashes, from_me, voted_at, updated_at
  FROM (
    SELECT DISTINCT ON (v.conversation_id, v.poll_wa_message_id, p.person)
           v.account, v.account_id, v.poll_wa_message_id, v.conversation_id, v.voter_jid,
           v.selected_options, v.selected_hashes, v.retracted, v.from_me, v.voted_at, v.updated_at
      FROM whatsapp_poll_votes v
      CROSS JOIN LATERAL (SELECT regexp_replace(v.voter_jid, '^[a-z][a-z0-9_-]*:', '') AS bare) x
      CROSS JOIN LATERAL (
        SELECT COALESCE(social_whatsapp_reactor_lid(v.account_id, x.bare), x.bare) AS person) p
     ORDER BY v.conversation_id, v.poll_wa_message_id, p.person,
              v.voted_at DESC NULLS LAST, v.updated_at DESC
  ) latest
 WHERE NOT retracted;

-- Current responses (cleared ones left out), same rules.
CREATE OR REPLACE VIEW whatsapp_event_responses_current AS
SELECT account, account_id, event_wa_message_id, conversation_id, responder_jid,
       response, extra_guest_count, from_me, responded_at, updated_at
  FROM (
    SELECT DISTINCT ON (e.conversation_id, e.event_wa_message_id, p.person)
           e.account, e.account_id, e.event_wa_message_id, e.conversation_id, e.responder_jid,
           e.response, e.extra_guest_count, e.from_me, e.responded_at, e.updated_at
      FROM whatsapp_event_responses e
      CROSS JOIN LATERAL (SELECT regexp_replace(e.responder_jid, '^[a-z][a-z0-9_-]*:', '') AS bare) x
      CROSS JOIN LATERAL (
        SELECT COALESCE(social_whatsapp_reactor_lid(e.account_id, x.bare), x.bare) AS person) p
     ORDER BY e.conversation_id, e.event_wa_message_id, p.person,
              e.responded_at DESC NULLS LAST, e.updated_at DESC
  ) latest
 WHERE response <> 'unknown';

-- 012's body verbatim + the votes / responses of the alias conversation move
-- with its messages.
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
  UPDATE whatsapp_poll_votes SET conversation_id = c.id WHERE conversation_id = a.id;
  UPDATE whatsapp_event_responses SET conversation_id = c.id WHERE conversation_id = a.id;
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

-- 011's body verbatim + the votes / responses of the moved polls / events go
-- back to the alias. One whose poll / event has no messages row stays on the
-- canonical conversation, like 011's reactions.
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
  UPDATE whatsapp_poll_votes SET conversation_id = p_alias
   WHERE poll_wa_message_id IN (SELECT wa_message_id FROM messages WHERE id = ANY (l.moved_message_ids));
  UPDATE whatsapp_event_responses SET conversation_id = p_alias
   WHERE event_wa_message_id IN (SELECT wa_message_id FROM messages WHERE id = ANY (l.moved_message_ids));
  -- Keep the alias row but block it, or the next periodic merge would redo it.
  UPDATE social_contact_aliases al SET evidence = 'blocked'
    FROM conversations c
   WHERE c.id = p_alias AND al.account_id = c.account_id AND al.alias_external_id = c.external_id;
  DELETE FROM social_conversation_merges WHERE id = l.id;
  RETURN 1;
END $$;
