-- Reactions live outside messages, so their writes need their own change hint.
-- migrate:always-run
-- The target lookup is account scoped; missing targets will be covered by the
-- message INSERT hint when history sync eventually stores the message.
CREATE TABLE IF NOT EXISTS whatsapp_message_reactions (
  account text NOT NULL,
  target_wa_message_id text NOT NULL,
  reactor_jid text NOT NULL,
  reaction_wa_message_id text,
  emoji text,
  removed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, target_wa_message_id, reactor_jid)
);

CREATE OR REPLACE FUNCTION socialmedia_reaction_change_hint() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target record;
  hint jsonb;
BEGIN
  SELECT m.id, m.conversation_id INTO target
    FROM messages m
   WHERE m.account = NEW.account
     AND m.wa_message_id = NEW.target_wa_message_id
     AND m.platform = 'whatsapp'
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  hint := jsonb_build_object(
    'kind', 'message',
    'account', NEW.account,
    'conversation_id', left(target.conversation_id::text, 512),
    'message_id', target.id::text,
    'wa_message_id', left(NEW.target_wa_message_id, 512),
    'reason', 'reaction'
  );

  BEGIN
    PERFORM pg_notify('socialmedia_changes', hint::text);
  EXCEPTION WHEN OTHERS THEN
    -- A UI hint must never roll back a reaction.
    RAISE WARNING 'socialmedia reaction hint failed for account %', NEW.account;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS reactions_realtime_insert_hint ON whatsapp_message_reactions;
CREATE TRIGGER reactions_realtime_insert_hint AFTER INSERT ON whatsapp_message_reactions
  FOR EACH ROW WHEN (NOT NEW.removed)
  EXECUTE FUNCTION socialmedia_reaction_change_hint();

DROP TRIGGER IF EXISTS reactions_realtime_update_hint ON whatsapp_message_reactions;
CREATE TRIGGER reactions_realtime_update_hint AFTER UPDATE ON whatsapp_message_reactions
  FOR EACH ROW WHEN (
    OLD.emoji IS DISTINCT FROM NEW.emoji
    OR OLD.removed IS DISTINCT FROM NEW.removed
  )
  EXECUTE FUNCTION socialmedia_reaction_change_hint();
