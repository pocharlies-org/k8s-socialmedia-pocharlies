-- migrate:always-run
-- CONTRACT: db.hindsight-platform-policy.v1
-- Reversible indexing pause. Existing queues, documents and message data stay intact.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS hindsight_sync_platform_policy (
  platform text PRIMARY KEY CHECK (platform IN ('whatsapp','telegram','instagram')),
  enabled boolean NOT NULL DEFAULT true
);
CREATE OR REPLACE FUNCTION hindsight_platform_enabled(provider text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT enabled FROM hindsight_sync_platform_policy WHERE platform=provider),true)
$$;

CREATE OR REPLACE FUNCTION hindsight_sync_capture_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m record;
BEGIN
  IF TG_OP = 'DELETE' THEN m := OLD; ELSE m := NEW; END IF;
  IF NOT hindsight_platform_enabled(m.platform) THEN RETURN NULL; END IF;
  INSERT INTO hindsight_sync_changes (message_id, scope)
  VALUES (m.id::text, jsonb_build_object(
    'platform', m.platform, 'namespace', m.account,
    'provider_account', CASE WHEN m.platform = 'instagram'
      THEN m.metadata->>'instagram_account' ELSE m.account END,
    'conversation_id', m.conversation_id, 'timestamp', m.wa_timestamp))
  ON CONFLICT (message_id) DO UPDATE SET
    revision = nextval('hindsight_sync_revision_seq'),
    scope = EXCLUDED.scope, changed_at = now();
  RETURN NULL;
END;
$$;


CREATE OR REPLACE FUNCTION hindsight_conversation_enqueue(s jsonb) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO hindsight_conversation_changes(scope_key,scope)
  SELECT jsonb_build_array(s->>'platform',s->>'namespace',s->>'provider_account',s->>'conversation_id',s->>'topic_id')::text,s
  WHERE hindsight_platform_enabled(s->>'platform')
  ON CONFLICT(scope_key) DO UPDATE SET revision=nextval('hindsight_conversation_revision_seq'),scope=EXCLUDED.scope,changed_at=now()
$$;

CREATE OR REPLACE FUNCTION hindsight_conversation_name_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r jsonb; s jsonb; ns text; ids text[]; raw text; old_value jsonb; new_value jsonb; provider text;
BEGIN
  -- Updating a title column to its current value must not scan historical topics.
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='conversations' THEN
    IF (OLD.name,OLD.metadata,OLD.account,OLD.account_id) IS NOT DISTINCT FROM
      (NEW.name,NEW.metadata,NEW.account,NEW.account_id) THEN RETURN NULL; END IF;
  END IF;
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
    provider:=NULL;
    IF TG_TABLE_NAME IN ('conversations','participants') THEN
      provider:=split_part(r->>'account_id',':',1);
    ELSIF TG_TABLE_NAME='conversation_participants' THEN
      SELECT split_part(c.account_id,':',1) INTO provider FROM conversations c WHERE c.id=r->>'conversation_id';
    ELSIF TG_TABLE_NAME='social_accounts' THEN
      provider:=r->>'channel';
    ELSIF TG_TABLE_NAME IN ('whatsapp_contacts','social_contact_aliases') THEN
      provider:='whatsapp';
    END IF;
    -- Exit before querying messages; filtering only the enqueue still burns CPU.
    IF provider IS NOT NULL AND NOT hindsight_platform_enabled(provider) THEN CONTINUE; END IF;
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
      WHERE hindsight_platform_enabled(m.platform) AND CASE
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
