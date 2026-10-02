-- Keep UUID message identities and every existing row. Conversation/participant
-- identities are rekeyed to provider text with a persistent legacy mapping.
-- Save and recreate every affected FK, including locally added references.
CREATE TEMP TABLE identity_foreign_keys ON COMMIT DROP AS
SELECT conrelid::regclass::text AS table_name, conname,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype = 'f' AND confrelid IN ('conversations'::regclass, 'participants'::regclass);
CREATE TEMP TABLE identity_columns ON COMMIT DROP AS
SELECT DISTINCT c.conrelid::regclass::text AS table_name, a.attname AS column_name
FROM pg_constraint c
CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS keys(source_attnum, target_attnum)
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = keys.source_attnum
JOIN pg_attribute target ON target.attrelid = c.confrelid AND target.attnum = keys.target_attnum
WHERE c.contype = 'f' AND c.confrelid IN ('conversations'::regclass, 'participants'::regclass)
  AND target.attname = 'id' AND a.atttypid = 'uuid'::regtype
UNION SELECT 'conversations', 'id'
UNION SELECT 'participants', 'id';
DO $$ DECLARE fk record; col record; BEGIN
  FOR fk IN SELECT * FROM identity_foreign_keys LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.table_name, fk.conname);
  END LOOP;
  FOR col IN
    SELECT * FROM identity_columns
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP DEFAULT', col.table_name, col.column_name);
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I TYPE text USING %I::text', col.table_name, col.column_name, col.column_name);
  END LOOP;
  FOR fk IN SELECT * FROM identity_foreign_keys LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', fk.table_name, fk.conname, fk.definition);
  END LOOP;
END $$;

ALTER TABLE conversations ALTER COLUMN wa_chat_id DROP NOT NULL, ALTER COLUMN type DROP NOT NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS participant_count integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unread_count integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
UPDATE conversations SET is_group = (type = 'GROUP') WHERE type IS NOT NULL;

ALTER TABLE participants ALTER COLUMN conversation_id DROP NOT NULL, ALTER COLUMN wa_user_id DROP NOT NULL;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS push_name text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS profile_pic_url text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS first_seen timestamptz NOT NULL DEFAULT now();
ALTER TABLE participants ADD COLUMN IF NOT EXISTS last_seen timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, participant_id)
);
INSERT INTO conversation_participants(conversation_id, participant_id, role, joined_at)
SELECT conversation_id, id, CASE WHEN is_admin THEN 'admin' ELSE 'member' END, COALESCE(joined_at, now())
FROM participants WHERE conversation_id IS NOT NULL ON CONFLICT DO NOTHING;

ALTER TABLE messages ALTER COLUMN content_hash DROP NOT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status_at timestamptz;
-- Preserve UUID reply relationships under an explicit legacy name. New writers
-- use provider reply IDs, including replies whose target was not imported yet.
ALTER TABLE messages RENAME COLUMN reply_to_message_id TO legacy_reply_to_message_id;
ALTER TABLE messages ADD COLUMN reply_to_message_id text;
UPDATE messages m SET reply_to_message_id = target.wa_message_id
FROM messages target WHERE m.legacy_reply_to_message_id = target.id;

ALTER TABLE attachments ALTER COLUMN type DROP NOT NULL, ALTER COLUMN storage_key DROP NOT NULL;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS file_type text;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS file_url text;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS thumbnail_url text;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS duration_seconds integer;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS caption text;
UPDATE attachments SET file_type = COALESCE(file_type, type), file_url = COALESCE(file_url, storage_key),
  thumbnail_url = COALESCE(thumbnail_url, thumbnail_key), duration_seconds = COALESCE(duration_seconds, duration);
ALTER TABLE draft_replies ALTER COLUMN language SET DEFAULT 'ES';

CREATE TABLE IF NOT EXISTS whatsapp_message_keys (
  wa_message_id text PRIMARY KEY REFERENCES messages(wa_message_id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  remote_jid text NOT NULL, from_me boolean NOT NULL, participant_jid text,
  message_timestamp_ms bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS whatsapp_sync_state (
  conversation_id text PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  oldest_message_id text, oldest_timestamp timestamptz, newest_timestamp timestamptz,
  total_imported bigint NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'pending',
  last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- Canonical IDs must match the IDs used by provider-based readers and writers.
-- Keep an audit mapping and retain duplicate legacy participant rows so distinct
-- historical names/admin metadata are never discarded during consolidation.
CREATE TABLE legacy_identity_map (
  entity text NOT NULL, legacy_id text NOT NULL, canonical_id text NOT NULL,
  account text NOT NULL, PRIMARY KEY(entity, legacy_id)
);
INSERT INTO legacy_identity_map
SELECT 'conversations', id,
  CASE WHEN wa_chat_id IS NULL OR wa_chat_id = '' THEN id
       WHEN account = 'personal' OR starts_with(wa_chat_id, account || ':') THEN wa_chat_id
       ELSE account || ':' || wa_chat_id END, account
FROM conversations;
INSERT INTO legacy_identity_map
SELECT 'participants', id,
  CASE WHEN wa_user_id IS NULL OR wa_user_id = '' THEN id
       WHEN account = 'personal' OR starts_with(wa_user_id, account || ':') THEN wa_user_id
       ELSE account || ':' || wa_user_id END, account
FROM participants;
INSERT INTO legacy_identity_map
SELECT 'message_provider_ids', wa_message_id,
  CASE WHEN account = 'personal' OR starts_with(wa_message_id, account || ':') THEN wa_message_id
       ELSE account || ':' || wa_message_id END, account
FROM messages;
CREATE TEMP TABLE provider_foreign_keys ON COMMIT DROP AS
SELECT c.conrelid::regclass::text AS table_name, c.conname,
       pg_get_constraintdef(c.oid) AS definition, a.attname AS column_name,
       CASE WHEN c.confrelid = 'messages'::regclass THEN 'message_provider_ids'
            ELSE c.confrelid::regclass::text END AS entity
FROM pg_constraint c
CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS keys(source_attnum, target_attnum)
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = keys.source_attnum
JOIN pg_attribute target ON target.attrelid = c.confrelid AND target.attnum = keys.target_attnum
WHERE c.contype = 'f' AND (
  (c.confrelid IN ('conversations'::regclass, 'participants'::regclass) AND target.attname = 'id') OR
  (c.confrelid = 'messages'::regclass AND target.attname = 'wa_message_id'));
CREATE TEMP TABLE canonical_participants ON COMMIT DROP AS
SELECT DISTINCT ON (canonical_id) legacy_id, canonical_id
FROM legacy_identity_map WHERE entity = 'participants'
ORDER BY canonical_id, (legacy_id = canonical_id) DESC, legacy_id;
DO $$ DECLARE fk record; BEGIN
  FOR fk IN SELECT DISTINCT table_name, conname FROM provider_foreign_keys LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.table_name, fk.conname);
  END LOOP;
  FOR fk IN SELECT * FROM provider_foreign_keys LOOP
    EXECUTE format('UPDATE %s t SET %I = map.canonical_id FROM legacy_identity_map map WHERE map.entity = %L AND t.%I = map.legacy_id AND map.legacy_id <> map.canonical_id', fk.table_name, fk.column_name, fk.entity, fk.column_name);
  END LOOP;
  UPDATE conversations c SET id = map.canonical_id, wa_chat_id = map.canonical_id
    FROM legacy_identity_map map WHERE map.entity = 'conversations' AND c.id = map.legacy_id AND map.legacy_id <> map.canonical_id;
  UPDATE participants p SET id = map.canonical_id
    FROM canonical_participants map WHERE p.id = map.legacy_id AND map.legacy_id <> map.canonical_id;
  UPDATE messages m SET wa_message_id = map.canonical_id
    FROM legacy_identity_map map WHERE map.entity = 'message_provider_ids' AND m.wa_message_id = map.legacy_id AND map.legacy_id <> map.canonical_id;
  -- These deployed history tables may not have had conversation FKs yet.
  UPDATE whatsapp_message_keys k SET conversation_id = map.canonical_id
    FROM legacy_identity_map map WHERE map.entity = 'conversations' AND k.conversation_id = map.legacy_id;
  UPDATE whatsapp_sync_state s SET conversation_id = map.canonical_id
    FROM legacy_identity_map map WHERE map.entity = 'conversations' AND s.conversation_id = map.legacy_id;
  FOR fk IN SELECT DISTINCT table_name, conname, definition FROM provider_foreign_keys LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', fk.table_name, fk.conname, fk.definition);
  END LOOP;
END $$;
UPDATE messages SET sender_wa_id = account || ':' || sender_wa_id
WHERE account <> 'personal' AND NOT starts_with(sender_wa_id, account || ':');
UPDATE messages m SET reply_to_message_id = target.wa_message_id
FROM messages target WHERE m.legacy_reply_to_message_id = target.id;
UPDATE whatsapp_sync_state s SET oldest_message_id = map.canonical_id
FROM legacy_identity_map map WHERE map.entity = 'message_provider_ids' AND s.oldest_message_id = map.legacy_id;

-- Existing NAS tables were created without these FKs. Fail atomically on orphans.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'whatsapp_message_keys'::regclass AND confrelid = 'conversations'::regclass AND contype = 'f') THEN
    ALTER TABLE whatsapp_message_keys ADD CONSTRAINT whatsapp_message_keys_conversation_id_fkey FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'whatsapp_sync_state'::regclass AND confrelid = 'conversations'::regclass AND contype = 'f') THEN
    ALTER TABLE whatsapp_sync_state ADD CONSTRAINT whatsapp_sync_state_conversation_id_fkey FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_keys_conversation_oldest ON whatsapp_message_keys(conversation_id, message_timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sync_state_status ON whatsapp_sync_state(status, updated_at DESC);
