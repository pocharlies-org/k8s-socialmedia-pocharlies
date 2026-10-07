-- Real-time change hints for the WhatsApp app.
--
-- The app builds every chat and message projection from Postgres through its
-- own account-scoped read API (visibility filter, LID/PN aliasing, reply joins,
-- provider state). A pushed row would duplicate that authority and drift from
-- it, so these triggers notify with IDENTIFIERS ONLY and the app server relays
-- them to the browser as hints that re-run the existing reads.
--
-- pg_notify inside the writing transaction means PostgreSQL delivers the hint
-- only after COMMIT, so a hint can never reach a reader before its row is
-- visible. That ordering is the whole reason this lives in the database rather
-- than in the connector's event emitters or NATS, which miss history-sync
-- writes, delivery receipts and unread badges entirely.

CREATE OR REPLACE FUNCTION socialmedia_change_hint() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  hint jsonb;
  conversation text;
BEGIN
  -- Branches are executed per table, so a field that only one of the two
  -- tables carries is never resolved for the other.
  IF TG_TABLE_NAME = 'messages' THEN
    -- The app only ever reads platform='whatsapp'; Telegram and Instagram rows
    -- in the same table must not wake WhatsApp browsers.
    IF NEW.platform IS DISTINCT FROM 'whatsapp' THEN
      RETURN NULL;
    END IF;
    conversation := NEW.conversation_id;
    hint := jsonb_build_object(
      'kind', TG_ARGV[0],
      'account', NEW.account,
      'conversation_id', left(NEW.conversation_id::text, 512),
      'message_id', NEW.id::text,
      'wa_message_id', left(NEW.wa_message_id::text, 512),
      'reason', lower(TG_OP)
    );
  ELSE
    conversation := NEW.id;
    hint := jsonb_build_object(
      'kind', TG_ARGV[0],
      'account', NEW.account,
      'conversation_id', left(NEW.id::text, 512),
      'reason', lower(TG_OP)
    );
  END IF;

  -- NOTIFY truncates past 8000 bytes; identifiers keep this far below it, but
  -- conversation ids are unbounded text, so degrade instead of truncating JSON.
  IF octet_length(hint::text) > 7000 THEN
    hint := jsonb_build_object(
      'kind', TG_ARGV[0], 'account', NEW.account,
      'conversation_id', left(conversation::text, 512), 'reason', 'truncated'
    );
  END IF;

  BEGIN
    PERFORM pg_notify('socialmedia_changes', hint::text);
  EXCEPTION WHEN OTHERS THEN
    -- This is a UI optimization, not a data invariant. A full notification
    -- queue or a future notification error must never roll back a message or
    -- chat write performed by Baileys, the MCP or the app server.
    RAISE WARNING 'socialmedia change hint failed for kind %, account %',
      TG_ARGV[0], NEW.account;
  END;
  RETURN NULL;
END;
$$;

-- Separate INSERT and UPDATE triggers: an INSERT row trigger has no OLD record,
-- so a shared WHEN clause referencing OLD would fail on insert.

DROP TRIGGER IF EXISTS messages_realtime_insert_hint ON messages;
CREATE TRIGGER messages_realtime_insert_hint AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION socialmedia_change_hint('message');

-- Only the fields the app renders. Ordinary bookkeeping writes (for example a
-- delivery status that did not actually move) stay silent.
DROP TRIGGER IF EXISTS messages_realtime_update_hint ON messages;
CREATE TRIGGER messages_realtime_update_hint AFTER UPDATE ON messages
  FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.is_edited IS DISTINCT FROM NEW.is_edited
    OR OLD.is_deleted IS DISTINCT FROM NEW.is_deleted
    OR OLD.content IS DISTINCT FROM NEW.content
    OR OLD.message_type IS DISTINCT FROM NEW.message_type
    OR OLD.metadata IS DISTINCT FROM NEW.metadata
  )
  EXECUTE FUNCTION socialmedia_change_hint('message');

DROP TRIGGER IF EXISTS conversations_realtime_insert_hint ON conversations;
CREATE TRIGGER conversations_realtime_insert_hint AFTER INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION socialmedia_change_hint('chat');

DROP TRIGGER IF EXISTS conversations_realtime_update_hint ON conversations;
CREATE TRIGGER conversations_realtime_update_hint AFTER UPDATE ON conversations
  FOR EACH ROW
  WHEN (
    OLD.unread_count IS DISTINCT FROM NEW.unread_count
    OR OLD.last_message_at IS DISTINCT FROM NEW.last_message_at
    OR OLD.archived IS DISTINCT FROM NEW.archived
    OR OLD.name IS DISTINCT FROM NEW.name
    OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url
    OR OLD.is_group IS DISTINCT FROM NEW.is_group
  )
  EXECUTE FUNCTION socialmedia_change_hint('chat');
