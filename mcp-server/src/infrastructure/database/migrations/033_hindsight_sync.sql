-- Optional Hindsight outbox; no foreign key so a hard delete leaves a tombstone.
-- Existing history is seeded in bounded batches only when the job is enabled.
CREATE SEQUENCE IF NOT EXISTS hindsight_sync_revision_seq;

CREATE TABLE IF NOT EXISTS hindsight_sync_changes (
  message_id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT nextval('hindsight_sync_revision_seq'),
  scope jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hindsight_sync_changes_revision_idx
  ON hindsight_sync_changes (revision);

CREATE TABLE IF NOT EXISTS hindsight_sync_destinations (
  destination text PRIMARY KEY,
  seed_last_id text,
  seeded boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS hindsight_sync_ledger (
  destination text NOT NULL,
  message_id text NOT NULL,
  source_revision bigint NOT NULL,
  version_hash text NOT NULL,
  selection_hash text NOT NULL,
  operation_id uuid NOT NULL,
  payload jsonb NOT NULL,
  is_deleted boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  indexed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (destination, message_id)
);
CREATE INDEX IF NOT EXISTS hindsight_sync_ledger_retry_idx
  ON hindsight_sync_ledger (destination, retry_at) WHERE status <> 'completed';

CREATE OR REPLACE FUNCTION hindsight_sync_capture_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m record;
BEGIN
  IF TG_OP = 'DELETE' THEN m := OLD; ELSE m := NEW; END IF;
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

DROP TRIGGER IF EXISTS trg_hindsight_sync_change ON messages;
CREATE TRIGGER trg_hindsight_sync_change
  AFTER INSERT OR DELETE OR UPDATE OF content, metadata, is_deleted, is_edited,
    wa_timestamp, sender_wa_id, direction, conversation_id, account, account_id, platform
  ON messages FOR EACH ROW EXECUTE FUNCTION hindsight_sync_capture_change();
