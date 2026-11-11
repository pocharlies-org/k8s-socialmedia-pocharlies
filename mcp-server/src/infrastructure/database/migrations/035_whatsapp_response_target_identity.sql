-- Poll/event notifications must support both legacy UUID and numeric message IDs.
-- Keep the response-key lookups within the same WhatsApp account as well.
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION social_fill_whatsapp_poll_vote_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s RECORD; r RECORD; v_canon TEXT; v_conv TEXT;
BEGIN
  IF NEW.account_id IS NULL THEN
    s := social_split_legacy_id(NEW.poll_wa_message_id, NEW.account, 'whatsapp');
    NEW.account_id := s.account_id;
  END IF;
  SELECT m.conversation_id INTO v_conv FROM messages m
   WHERE m.wa_message_id = NEW.poll_wa_message_id
     AND m.platform = 'whatsapp' AND m.account = NEW.account
     AND m.account_id IS NOT DISTINCT FROM NEW.account_id;
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
  SELECT m.conversation_id INTO v_conv FROM messages m
   WHERE m.wa_message_id = NEW.event_wa_message_id
     AND m.platform = 'whatsapp' AND m.account = NEW.account
     AND m.account_id IS NOT DISTINCT FROM NEW.account_id;
  NEW.conversation_id := COALESCE(v_conv, NEW.conversation_id);
  NEW.responder_seen_jid := COALESCE(NEW.responder_seen_jid, NEW.responder_jid);
  r := social_split_legacy_id(NEW.responder_jid, NEW.account, 'whatsapp');
  v_canon := social_whatsapp_reactor_lid(NEW.account_id, r.external_id);
  IF v_canon IS NOT NULL THEN
    NEW.responder_jid := left(NEW.responder_jid, length(NEW.responder_jid) - length(r.external_id)) || v_canon;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION social_notify_whatsapp_response() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_target TEXT; v_id messages.id%TYPE; v_conv TEXT; v_kind TEXT;
BEGIN
  IF TG_TABLE_NAME = 'whatsapp_poll_votes' THEN
    v_target := NEW.poll_wa_message_id; v_kind := 'poll';
  ELSE
    v_target := NEW.event_wa_message_id; v_kind := 'event';
  END IF;
  SELECT m.id, m.conversation_id INTO v_id, v_conv FROM messages m
   WHERE m.wa_message_id = v_target
     AND m.platform = 'whatsapp' AND m.account = NEW.account
     AND m.account_id IS NOT DISTINCT FROM NEW.account_id
     AND m.conversation_id = NEW.conversation_id;
  IF v_id IS NOT NULL THEN
    PERFORM pg_notify('message_updated', json_build_object(
      'id', v_id, 'conversation_id', v_conv, 'kind', v_kind)::text);
  END IF;
  RETURN NULL;
END $$;
