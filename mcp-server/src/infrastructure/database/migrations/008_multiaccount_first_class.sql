-- 008 — Multicuenta de primera clase (docs/adr/0001-multiaccount-first-class.md).
--
-- EXPAND only: adds tables, nullable columns, functions and triggers. Nothing is
-- renamed or dropped; legacy ids (`professional:<jid>`) and the `account` column
-- keep working for every existing reader and writer.
--
-- Idempotent: every statement is IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT,
-- so re-running it (or the ledger baselining it on social_accounts) is harmless.
-- The row backfill and the UNIQUE (account_id, external_id) indexes are NOT
-- here: they run batched / CONCURRENTLY from src/jobs/multiaccount-backfill.ts.

CREATE TABLE IF NOT EXISTS social_accounts (
  id               TEXT PRIMARY KEY,               -- '<channel>:<accountKey>'
  channel          TEXT NOT NULL CHECK (channel IN ('whatsapp', 'telegram', 'instagram')),
  account_key      TEXT NOT NULL,
  label            TEXT NOT NULL,
  legacy_namespace TEXT NOT NULL,                  -- value of the legacy `account` column
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel, account_key)
);

CREATE TABLE IF NOT EXISTS social_profiles (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS social_profile_accounts (
  profile_id TEXT NOT NULL REFERENCES social_profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, account_id)
);

-- Seed = the registry as deployed on 24-09 (the MCP keeps it in sync from
-- k8s/base/social-accounts.json afterwards; rows are never deleted).
INSERT INTO social_accounts (id, channel, account_key, label, legacy_namespace) VALUES
  ('whatsapp:personal',     'whatsapp',  'personal',     'WhatsApp personal',     'personal'),
  ('whatsapp:professional', 'whatsapp',  'professional', 'WhatsApp professional', 'professional'),
  ('whatsapp:leila',        'whatsapp',  'leila',        'WhatsApp leila',        'leila'),
  ('telegram:personal',     'telegram',  'personal',     'Telegram personal',     'personal'),
  ('telegram:professional', 'telegram',  'professional', 'Telegram professional', 'professional'),
  ('instagram:skirmshop',   'instagram', 'skirmshop',    'Instagram skirmshopes', 'professional'),
  ('instagram:barbelpapis', 'instagram', 'barbelpapis',  'Instagram barbelpapis', 'personal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO social_profiles (id, label) VALUES
  ('personal', 'Personal'), ('professional', 'Profesional'), ('leila', 'Leila')
ON CONFLICT (id) DO NOTHING;

INSERT INTO social_profile_accounts (profile_id, account_id) VALUES
  ('personal', 'whatsapp:personal'), ('personal', 'telegram:personal'),
  ('personal', 'instagram:barbelpapis'),
  ('professional', 'whatsapp:professional'), ('professional', 'telegram:professional'),
  ('professional', 'instagram:skirmshop'),
  ('leila', 'whatsapp:leila')
ON CONFLICT DO NOTHING;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS account_id  TEXT REFERENCES social_accounts(id);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS external_id TEXT;
-- Tombstone: this conversation is an alias of another contact identity; its
-- messages live in merged_into. Kept (not deleted) so writers' FKs stay valid.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS merged_into TEXT REFERENCES conversations(id);
ALTER TABLE messages      ADD COLUMN IF NOT EXISTS account_id  TEXT REFERENCES social_accounts(id);
ALTER TABLE messages      ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE participants  ADD COLUMN IF NOT EXISTS account_id  TEXT REFERENCES social_accounts(id);
ALTER TABLE participants  ADD COLUMN IF NOT EXISTS external_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_merged_into ON conversations (merged_into)
  WHERE merged_into IS NOT NULL;

-- Contact identity: within one account, an alias id resolves to a canonical id.
CREATE TABLE IF NOT EXISTS social_contact_aliases (
  account_id            TEXT NOT NULL REFERENCES social_accounts(id),
  alias_external_id     TEXT NOT NULL,
  canonical_external_id TEXT NOT NULL,
  evidence              TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, alias_external_id),
  CHECK (alias_external_id <> canonical_external_id)
);

-- Audit / rollback log of every conversation merge.
CREATE TABLE IF NOT EXISTS social_conversation_merges (
  id                        BIGSERIAL PRIMARY KEY,
  alias_conversation_id     TEXT NOT NULL UNIQUE,
  canonical_conversation_id TEXT NOT NULL,
  moved_message_ids         BIGINT[] NOT NULL DEFAULT '{}',
  moved_key_ids             TEXT[] NOT NULL DEFAULT '{}',
  merged_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Legacy id → (account_id, external_id) ─────────────────────────────────
-- The ONE place that understands the legacy id shapes:
--   <ns>:<raw>  for every namespace but personal (ns = a legacy_namespace)
--   tg_...      Telegram;  ig_<igAccount>_... / ig_<igsid>  Instagram
-- Returns NULLs when it cannot tell: a writer's INSERT never fails because of it.
CREATE OR REPLACE FUNCTION social_split_legacy_id(
  p_id TEXT, p_account TEXT, p_platform TEXT,
  OUT account_id TEXT, OUT external_id TEXT
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_ns TEXT := COALESCE(NULLIF(p_account, ''), 'personal');
  v_raw TEXT := p_id;
  v_prefix TEXT;
  v_channel TEXT := NULLIF(p_platform, '');
  v_ig TEXT;
BEGIN
  IF p_id IS NULL THEN RETURN; END IF;
  v_prefix := substring(p_id FROM '^([a-z][a-z0-9_-]*):');
  IF v_prefix IS NOT NULL AND v_prefix <> 'personal' AND EXISTS (
       SELECT 1 FROM social_accounts a WHERE a.legacy_namespace = v_prefix) THEN
    v_ns := v_prefix;
    v_raw := substr(p_id, length(v_prefix) + 2);
  END IF;
  IF v_channel IS NULL OR v_channel NOT IN ('whatsapp', 'telegram', 'instagram') THEN
    v_channel := CASE WHEN v_raw LIKE 'tg\_%' THEN 'telegram'
                      WHEN v_raw LIKE 'ig\_%' THEN 'instagram'
                      ELSE 'whatsapp' END;
  END IF;
  external_id := v_raw;
  IF v_channel = 'instagram' THEN
    -- ig_<account>_... carries the Instagram account; bare ig_<igsid>
    -- participants predate that and are filed by namespace.
    SELECT a.id INTO v_ig FROM social_accounts a
     WHERE a.channel = 'instagram' AND v_raw LIKE 'ig\_' || replace(a.account_key, '_', '\_') || '\_%'
     ORDER BY length(a.account_key) DESC LIMIT 1;
    IF v_ig IS NULL THEN
      SELECT a.id INTO v_ig FROM social_accounts a
       WHERE a.channel = 'instagram' AND a.legacy_namespace = v_ns
       ORDER BY a.id LIMIT 1;
    END IF;
    account_id := v_ig;
  ELSE
    SELECT a.id INTO account_id FROM social_accounts a
     WHERE a.channel = v_channel AND a.legacy_namespace = v_ns;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION social_fill_conversation_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s RECORD;
BEGIN
  IF NEW.account_id IS NULL OR NEW.external_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id) THEN
    s := social_split_legacy_id(NEW.id, NEW.account, NULL);
    NEW.account_id := COALESCE(NEW.account_id, s.account_id);
    NEW.external_id := COALESCE(NEW.external_id, s.external_id);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION social_fill_message_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s RECORD; v_target TEXT;
BEGIN
  -- Redirect writes aimed at a merged (tombstone) conversation to its canonical one.
  IF NEW.conversation_id IS NOT NULL THEN
    SELECT merged_into INTO v_target FROM conversations WHERE id = NEW.conversation_id;
    IF v_target IS NOT NULL THEN NEW.conversation_id := v_target; END IF;
  END IF;
  IF NEW.account_id IS NULL OR NEW.external_id IS NULL THEN
    s := social_split_legacy_id(NEW.wa_message_id, NEW.account, NEW.platform);
    NEW.account_id := COALESCE(NEW.account_id, s.account_id);
    NEW.external_id := COALESCE(NEW.external_id, s.external_id);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION social_fill_participant_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s RECORD;
BEGIN
  IF NEW.account_id IS NULL OR NEW.external_id IS NULL THEN
    s := social_split_legacy_id(NEW.id, NEW.account, NULL);
    NEW.account_id := COALESCE(NEW.account_id, s.account_id);
    NEW.external_id := COALESCE(NEW.external_id, s.external_id);
  END IF;
  RETURN NEW;
END $$;

-- Generic redirect for the other conversation-scoped writers.
CREATE OR REPLACE FUNCTION social_redirect_merged_conversation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_target TEXT;
BEGIN
  IF NEW.conversation_id IS NOT NULL THEN
    SELECT merged_into INTO v_target FROM conversations WHERE id = NEW.conversation_id;
    IF v_target IS NOT NULL THEN NEW.conversation_id := v_target; END IF;
  END IF;
  RETURN NEW;
END $$;

-- A writer that keeps touching the tombstone (last_message_at, unread) is
-- reflected on the canonical conversation.
CREATE OR REPLACE FUNCTION social_propagate_tombstone_activity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.merged_into IS NOT NULL AND NEW.last_message_at IS DISTINCT FROM OLD.last_message_at THEN
    UPDATE conversations
       SET last_message_at = GREATEST(COALESCE(last_message_at, NEW.last_message_at), NEW.last_message_at),
           updated_at = NOW()
     WHERE id = NEW.merged_into;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_social_conversation_keys ON conversations;
CREATE TRIGGER trg_social_conversation_keys BEFORE INSERT OR UPDATE OF id, account, account_id, external_id
  ON conversations FOR EACH ROW EXECUTE FUNCTION social_fill_conversation_keys();

DROP TRIGGER IF EXISTS trg_social_tombstone_activity ON conversations;
CREATE TRIGGER trg_social_tombstone_activity AFTER UPDATE OF last_message_at
  ON conversations FOR EACH ROW WHEN (NEW.merged_into IS NOT NULL)
  EXECUTE FUNCTION social_propagate_tombstone_activity();

DROP TRIGGER IF EXISTS trg_social_message_keys ON messages;
CREATE TRIGGER trg_social_message_keys BEFORE INSERT OR UPDATE OF conversation_id, wa_message_id, account
  ON messages FOR EACH ROW EXECUTE FUNCTION social_fill_message_keys();

DROP TRIGGER IF EXISTS trg_social_participant_keys ON participants;
CREATE TRIGGER trg_social_participant_keys BEFORE INSERT OR UPDATE OF id, account
  ON participants FOR EACH ROW EXECUTE FUNCTION social_fill_participant_keys();

DROP TRIGGER IF EXISTS trg_social_redirect ON whatsapp_message_keys;
CREATE TRIGGER trg_social_redirect BEFORE INSERT OR UPDATE OF conversation_id
  ON whatsapp_message_keys FOR EACH ROW EXECUTE FUNCTION social_redirect_merged_conversation();

DROP TRIGGER IF EXISTS trg_social_redirect ON draft_replies;
CREATE TRIGGER trg_social_redirect BEFORE INSERT OR UPDATE OF conversation_id
  ON draft_replies FOR EACH ROW EXECUTE FUNCTION social_redirect_merged_conversation();

DROP TRIGGER IF EXISTS trg_social_redirect ON whatsapp_sync_state;
CREATE TRIGGER trg_social_redirect BEFORE INSERT
  ON whatsapp_sync_state FOR EACH ROW EXECUTE FUNCTION social_redirect_merged_conversation();

DROP TRIGGER IF EXISTS trg_social_redirect ON conversation_participants;
CREATE TRIGGER trg_social_redirect BEFORE INSERT
  ON conversation_participants FOR EACH ROW EXECUTE FUNCTION social_redirect_merged_conversation();

-- ── Contact aliases: discovery + merge ───────────────────────────────────
-- Evidence (measured 24-09): inbound messages of a 1:1 @lid conversation carry
-- metadata.senderPnE164. Canonical = the @lid conversation (what the connector
-- writes today); aliases = the phone-number forms (@s.whatsapp.net / @c.us).
CREATE OR REPLACE FUNCTION social_discover_contact_aliases() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER := 0; k INTEGER;
BEGIN
  WITH ev AS (
    SELECT DISTINCT c.account_id, c.external_id AS lid,
           regexp_replace(m.metadata->>'senderPnE164', '[^0-9]', '', 'g') AS digits
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
     WHERE c.external_id LIKE '%@lid' AND c.merged_into IS NULL AND c.account_id IS NOT NULL
       AND m.direction = 'INBOUND' AND COALESCE(m.metadata->>'senderPnE164', '') <> ''
  ), one AS (
    -- one phone per LID and one LID per phone, or the evidence is ambiguous
    SELECT * FROM ev e
     WHERE length(e.digits) >= 8
       AND (SELECT count(DISTINCT digits) FROM ev x WHERE x.account_id = e.account_id AND x.lid = e.lid) = 1
       AND (SELECT count(DISTINCT lid) FROM ev x WHERE x.account_id = e.account_id AND x.digits = e.digits) = 1
  )
  INSERT INTO social_contact_aliases (account_id, alias_external_id, canonical_external_id, evidence)
  SELECT account_id, digits || sfx, lid, 'senderPnE164'
    FROM one, (VALUES ('@s.whatsapp.net'), ('@c.us')) AS f(sfx)
  ON CONFLICT (account_id, alias_external_id) DO NOTHING;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  -- Same phone stored under both suffixes and no LID known: @c.us → @s.whatsapp.net.
  INSERT INTO social_contact_aliases (account_id, alias_external_id, canonical_external_id, evidence)
  SELECT a.account_id, a.external_id, b.external_id, 'pn-suffix'
    FROM conversations a
    JOIN conversations b ON b.account_id = a.account_id
     AND b.external_id = replace(a.external_id, '@c.us', '@s.whatsapp.net')
   WHERE a.external_id LIKE '%@c.us' AND a.merged_into IS NULL AND b.merged_into IS NULL
  ON CONFLICT (account_id, alias_external_id) DO NOTHING;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  -- The connector (and the pre-008 MCP send gate) store the phone jid of a LID
  -- conversation in wa_chat_id. Only unambiguous pairs: 26 wa_chat_id values
  -- are shared by several conversations (measured 24-09) and are skipped.
  WITH wc AS (
    SELECT c.account_id, c.external_id AS lid,
           regexp_replace(c.wa_chat_id, '^[a-z][a-z0-9_-]*:', '') AS pn
      FROM conversations c
     WHERE c.external_id LIKE '%@lid' AND c.merged_into IS NULL AND c.account_id IS NOT NULL
       AND c.wa_chat_id ~ '^([a-z][a-z0-9_-]*:)?[0-9]{8,}@s\.whatsapp\.net$'
  )
  INSERT INTO social_contact_aliases (account_id, alias_external_id, canonical_external_id, evidence)
  SELECT w.account_id, w.pn, w.lid, 'wa_chat_id'
    FROM wc w
   WHERE (SELECT count(*) FROM wc x WHERE x.account_id = w.account_id AND x.pn = w.pn) = 1
  ON CONFLICT (account_id, alias_external_id) DO NOTHING;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  RETURN n;
END $$;

-- Live capture of the same evidence: a writer that sets the phone jid of a LID
-- conversation records the alias too (no connector change needed).
CREATE OR REPLACE FUNCTION social_capture_wa_chat_alias() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_pn TEXT;
BEGIN
  IF NEW.account_id IS NULL OR NEW.external_id NOT LIKE '%@lid' OR NEW.merged_into IS NOT NULL THEN
    RETURN NULL;
  END IF;
  v_pn := regexp_replace(COALESCE(NEW.wa_chat_id, ''), '^[a-z][a-z0-9_-]*:', '');
  IF v_pn ~ '^[0-9]{8,}@s\.whatsapp\.net$' THEN
    INSERT INTO social_contact_aliases (account_id, alias_external_id, canonical_external_id, evidence)
    VALUES (NEW.account_id, v_pn, NEW.external_id, 'wa_chat_id')
    ON CONFLICT (account_id, alias_external_id) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_social_wa_chat_alias ON conversations;
CREATE TRIGGER trg_social_wa_chat_alias AFTER INSERT OR UPDATE OF wa_chat_id
  ON conversations FOR EACH ROW EXECUTE FUNCTION social_capture_wa_chat_alias();

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

-- Merge every known alias whose two conversations both exist. Idempotent.
CREATE OR REPLACE FUNCTION social_merge_contact_aliases() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD; n INTEGER := 0; v_canon TEXT;
BEGIN
  PERFORM social_discover_contact_aliases();
  FOR r IN
    SELECT al.account_id, ca.id AS alias_id, cc.id AS canonical_id, cc.merged_into AS canonical_merged
      FROM social_contact_aliases al
      JOIN conversations ca ON ca.account_id = al.account_id AND ca.external_id = al.alias_external_id
      JOIN conversations cc ON cc.account_id = al.account_id AND cc.external_id = al.canonical_external_id
     WHERE ca.merged_into IS NULL AND al.evidence <> 'blocked'
  LOOP
    v_canon := COALESCE(r.canonical_merged, r.canonical_id);
    n := n + social_merge_conversation(r.alias_id, v_canon);
  END LOOP;
  RETURN n;
END $$;

-- Rollback of one merge (moves the logged rows back, clears the tombstone and
-- blocks the alias so it is not merged again).
CREATE OR REPLACE FUNCTION social_unmerge_conversation(p_alias TEXT) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE l RECORD;
BEGIN
  SELECT * INTO l FROM social_conversation_merges WHERE alias_conversation_id = p_alias;
  IF l.id IS NULL THEN RETURN 0; END IF;
  UPDATE conversations SET merged_into = NULL, updated_at = NOW() WHERE id = p_alias;
  UPDATE messages SET conversation_id = p_alias WHERE id = ANY (l.moved_message_ids);
  UPDATE whatsapp_message_keys SET conversation_id = p_alias WHERE wa_message_id = ANY (l.moved_key_ids);
  -- Keep the alias row but block it, or the next periodic merge would redo it.
  UPDATE social_contact_aliases al SET evidence = 'blocked'
    FROM conversations c
   WHERE c.id = p_alias AND al.account_id = c.account_id AND al.alias_external_id = c.external_id;
  DELETE FROM social_conversation_merges WHERE id = l.id;
  RETURN 1;
END $$;
