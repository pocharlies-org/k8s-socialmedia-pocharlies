-- 017 — announce edits and deletes of messages on the `message_updated` channel.
--
-- The only UPDATE notify on messages (messages_notify_status) fires when
-- `status` changes. Edits and deletes written by the WhatsApp connector
-- (message-mutations.ts, PR-3) and by telegram-sync (#114) change content /
-- is_edited / is_deleted / metadata without touching status, so open
-- /messages chats never refresh them. dgx-messages (#25) already renders a
-- `message_updated` event of kind `edit` or `delete` for a row on screen.
--
-- Additive and idempotent: CREATE OR REPLACE the function, create the
-- trigger only if it is missing. CREATE TRIGGER takes a SHARE ROW EXCLUSIVE
-- lock on messages for the (tiny) rest of the transaction; lock_timeout makes
-- a blocked run fail and the PreSync Job retry instead of queueing writers.
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION notify_message_edit_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_deleted IS DISTINCT FROM OLD.is_deleted
     OR (NEW.metadata -> 'deleted_for_me') IS DISTINCT FROM (OLD.metadata -> 'deleted_for_me') THEN
    PERFORM pg_notify('message_updated', json_build_object(
      'id', NEW.id, 'conversation_id', NEW.conversation_id, 'kind', 'delete')::text);
  ELSIF NEW.is_edited IS DISTINCT FROM OLD.is_edited
     OR NEW.content IS DISTINCT FROM OLD.content
     OR (NEW.metadata -> 'edit_history') IS DISTINCT FROM (OLD.metadata -> 'edit_history') THEN
    PERFORM pg_notify('message_updated', json_build_object(
      'id', NEW.id, 'conversation_id', NEW.conversation_id, 'kind', 'edit')::text);
  END IF;
  RETURN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'messages_notify_edit_delete'
       AND tgrelid = 'messages'::regclass
  ) THEN
    CREATE TRIGGER messages_notify_edit_delete
      AFTER UPDATE OF content, is_edited, is_deleted, metadata ON messages
      FOR EACH ROW EXECUTE FUNCTION notify_message_edit_delete();
  END IF;
END $$;
