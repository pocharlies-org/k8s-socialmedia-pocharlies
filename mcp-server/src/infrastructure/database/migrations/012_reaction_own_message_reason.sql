-- Tell the two sides of a reaction apart so the app can notify only about what
-- actually concerns this account: a different person reacting to a message this
-- account sent.
--
-- 011 is checksum-locked in schema_migrations, so its reason cannot be rewritten
-- in place; the extra fact is carried here instead. The hint keeps the 011 shape
-- -- identifiers only, no emoji and no author -- and only widens the vocabulary
-- of `reason`, which the app already treats as an open set.
--
-- from_me is nullable on purpose. Rows imported before the author side was
-- tracked stay NULL, and an unknown side must never be read as a peer reaction,
-- so it keeps the generic reason.

ALTER TABLE whatsapp_message_reactions
  ADD COLUMN IF NOT EXISTS from_me boolean;

CREATE OR REPLACE FUNCTION socialmedia_reaction_change_hint() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target record;
  reason text;
  hint jsonb;
BEGIN
  SELECT m.id, m.conversation_id, m.direction INTO target
    FROM messages m
   WHERE m.account = NEW.account
     AND m.wa_message_id = NEW.target_wa_message_id
     AND m.platform = 'whatsapp'
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- The dedicated reason is reserved for a reaction that just landed on a
  -- message this account sent and was written by someone else. Everything else
  -- keeps the reason 011 promised: our own taps (including the echo of a send
  -- from reactToMessage), reactions on incoming messages, withdrawals, and
  -- rows whose author side was never recorded.
  IF target.direction = 'OUTBOUND' AND NEW.from_me IS FALSE AND NOT NEW.removed THEN
    reason := 'reaction-to-own-message';
  ELSE
    reason := 'reaction';
  END IF;

  hint := jsonb_build_object(
    'kind', 'message',
    'account', NEW.account,
    'conversation_id', left(target.conversation_id::text, 512),
    'message_id', target.id::text,
    'wa_message_id', left(NEW.target_wa_message_id, 512),
    'reason', reason
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
