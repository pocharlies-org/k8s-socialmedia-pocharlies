-- migrate:always-run
-- No FK: message/conversation hard deletes must leave durable tombstones.
CREATE SEQUENCE IF NOT EXISTS hindsight_conversation_revision_seq;
CREATE TABLE IF NOT EXISTS hindsight_conversation_changes (
  scope_key text PRIMARY KEY,
  scope jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT nextval('hindsight_conversation_revision_seq'),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hindsight_conversation_destinations (
  destination text PRIMARY KEY,
  seed_last_id uuid,
  seeded boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS hindsight_conversation_documents (
  destination text NOT NULL,
  document_id text NOT NULL,
  scope_key text NOT NULL,
  platform text NOT NULL,
  namespace text NOT NULL,
  provider_account text NOT NULL,
  conversation_id text NOT NULL,
  topic_id text NOT NULL DEFAULT '',
  source_revision bigint NOT NULL,
  selection_hash text NOT NULL,
  message_ids uuid[] NOT NULL DEFAULT '{}',
  confirmed jsonb,
  pending jsonb,
  last_operation_id uuid,
  status text NOT NULL CHECK (status IN ('pending','accepted','completed','failed')),
  retry_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(destination,document_id),
  UNIQUE(destination,scope_key)
);
ALTER TABLE hindsight_conversation_documents ADD COLUMN IF NOT EXISTS last_operation_id uuid;
CREATE INDEX IF NOT EXISTS hindsight_conversation_documents_retry_idx
  ON hindsight_conversation_documents(destination,retry_at) WHERE pending IS NOT NULL;

CREATE OR REPLACE FUNCTION hindsight_conversation_scope(m jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('platform',m->>'platform','namespace',m->>'account',
    'provider_account',CASE WHEN m->>'platform'='instagram' THEN COALESCE(m->'metadata'->>'instagram_account','') ELSE m->>'account' END,
    'conversation_id',m->>'conversation_id','topic_id',CASE WHEN m->>'platform'='telegram'
      THEN COALESCE(NULLIF(m->'metadata'->>'topic_id',''),NULLIF(m->'metadata'->>'thread_id',''),NULLIF(m->'metadata'->>'telegram_topic_id',''),'') ELSE '' END)
$$;
CREATE OR REPLACE FUNCTION hindsight_conversation_enqueue(s jsonb) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO hindsight_conversation_changes(scope_key,scope)
  VALUES(jsonb_build_array(s->>'platform',s->>'namespace',s->>'provider_account',s->>'conversation_id',s->>'topic_id')::text,s)
  ON CONFLICT(scope_key) DO UPDATE SET revision=nextval('hindsight_conversation_revision_seq'),scope=EXCLUDED.scope,changed_at=now()
$$;
CREATE OR REPLACE FUNCTION hindsight_conversation_message_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM hindsight_conversation_enqueue(hindsight_conversation_scope(to_jsonb(OLD))); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM hindsight_conversation_enqueue(hindsight_conversation_scope(to_jsonb(NEW))); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_hindsight_conversation_message ON messages;
CREATE TRIGGER trg_hindsight_conversation_message AFTER INSERT OR DELETE OR UPDATE OF
  content,metadata,is_deleted,is_edited,wa_timestamp,sender_wa_id,direction,conversation_id,account,account_id,platform
  ON messages FOR EACH ROW EXECUTE FUNCTION hindsight_conversation_message_change();

-- Name and membership changes rebuild existing scopes without a new message.
CREATE OR REPLACE FUNCTION hindsight_conversation_name_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r jsonb; s jsonb; ns text; ids text[]; raw text; old_value jsonb; new_value jsonb;
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('participants','whatsapp_contacts','social_accounts','social_contact_aliases') THEN
    old_value:=to_jsonb(OLD); new_value:=to_jsonb(NEW);
    IF (old_value->'name',old_value->'push_name',old_value->'phone',old_value->'account',old_value->'label',
      old_value->'enabled',old_value->'alias_external_id',old_value->'canonical_external_id',old_value->'evidence')
      IS NOT DISTINCT FROM
      (new_value->'name',new_value->'push_name',new_value->'phone',new_value->'account',new_value->'label',
      new_value->'enabled',new_value->'alias_external_id',new_value->'canonical_external_id',new_value->'evidence') THEN RETURN NULL; END IF;
  END IF;
  FOR r IN SELECT v FROM unnest(CASE WHEN TG_OP='INSERT' THEN ARRAY[to_jsonb(NEW)]
    WHEN TG_OP='DELETE' THEN ARRAY[to_jsonb(OLD)] ELSE ARRAY[to_jsonb(OLD),to_jsonb(NEW)] END) v LOOP
    ns:=r->>'account';
    IF TG_TABLE_NAME='social_contact_aliases' THEN
      SELECT legacy_namespace INTO ns FROM social_accounts WHERE id=r->>'account_id';
    END IF;
    raw:=COALESCE(r->>'jid',r->>'id',r->>'alias_external_id');
    IF ns<>'personal' AND starts_with(raw,ns||':') THEN raw:=substr(raw,length(ns)+2); END IF;
    ids:=ARRAY[raw,replace(raw,'@c.us','@s.whatsapp.net'),replace(raw,'@s.whatsapp.net','@c.us'),r->>'canonical_external_id'];
    IF TG_TABLE_NAME IN ('participants','whatsapp_contacts','social_contact_aliases') THEN
      SELECT ids || COALESCE(array_agg(a.alias_external_id) FILTER(WHERE a.alias_external_id IS NOT NULL),'{}') ||
        COALESCE(array_agg(a.canonical_external_id) FILTER(WHERE a.canonical_external_id IS NOT NULL),'{}') INTO ids
      FROM social_contact_aliases a WHERE a.account_id='whatsapp:'||ns AND a.evidence<>'blocked'
        AND (a.alias_external_id=ANY(ids) OR a.canonical_external_id=ANY(ids));
      ids:=ids || ARRAY(SELECT ns||':'||v FROM unnest(ids) v);
    END IF;
    FOR s IN SELECT DISTINCT hindsight_conversation_scope(to_jsonb(m)) FROM messages m
      WHERE CASE
        WHEN TG_TABLE_NAME='conversations' THEN m.conversation_id=r->>'id'
        WHEN TG_TABLE_NAME='conversation_participants' THEN m.conversation_id=r->>'conversation_id'
        WHEN TG_TABLE_NAME='social_accounts' THEN m.platform=r->>'channel' AND m.account=r->>'legacy_namespace'
        ELSE m.account=ns AND (m.sender_wa_id=ANY(ids) OR m.conversation_id=ANY(ids)
          OR (TG_TABLE_NAME='participants' AND EXISTS(SELECT 1 FROM conversation_participants cp
            WHERE cp.conversation_id=m.conversation_id AND cp.participant_id=r->>'id')))
          AND (TG_TABLE_NAME='participants' OR m.platform='whatsapp') END
    LOOP PERFORM hindsight_conversation_enqueue(s); END LOOP;
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_hindsight_conversation_name ON conversations;
CREATE TRIGGER trg_hindsight_conversation_name AFTER UPDATE OF name,metadata,account ON conversations
  FOR EACH ROW EXECUTE FUNCTION hindsight_conversation_name_change();
DROP TRIGGER IF EXISTS trg_hindsight_participant_name ON participants;
CREATE TRIGGER trg_hindsight_participant_name AFTER INSERT OR DELETE OR UPDATE OF name,push_name,phone,account ON participants
  FOR EACH ROW EXECUTE FUNCTION hindsight_conversation_name_change();
DROP TRIGGER IF EXISTS trg_hindsight_membership ON conversation_participants;
CREATE TRIGGER trg_hindsight_membership AFTER INSERT OR DELETE OR UPDATE ON conversation_participants
  FOR EACH ROW EXECUTE FUNCTION hindsight_conversation_name_change();
DROP TRIGGER IF EXISTS trg_hindsight_account_name ON social_accounts;
CREATE TRIGGER trg_hindsight_account_name AFTER UPDATE OF label,enabled ON social_accounts
  FOR EACH ROW EXECUTE FUNCTION hindsight_conversation_name_change();
DROP TRIGGER IF EXISTS trg_hindsight_contact_alias ON social_contact_aliases;
CREATE TRIGGER trg_hindsight_contact_alias AFTER INSERT OR DELETE OR UPDATE ON social_contact_aliases
  FOR EACH ROW EXECUTE FUNCTION hindsight_conversation_name_change();
DO $$ BEGIN
  IF to_regclass('whatsapp_contacts') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_hindsight_contact_name ON whatsapp_contacts;
    CREATE TRIGGER trg_hindsight_contact_name AFTER INSERT OR DELETE OR UPDATE OF name,push_name,phone ON whatsapp_contacts
      FOR EACH ROW EXECUTE FUNCTION hindsight_conversation_name_change();
  END IF;
END $$;
