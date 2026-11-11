-- 015 — versioned inbound-reaction merge + two WhatsApp backfills (fase 3
-- follow-up).
--
-- 1. merge_inbound_reaction() + trg_merge_inbound_reaction on messages existed
--    in prod only (created by hand, in no repo). They are declared here with
--    prod's definition (pg_get_functiondef / pg_get_triggerdef, read 01-10)
--    and ONE fix: the target was looked up in NEW.conversation_id, the chat
--    the reaction came in. BEFORE triggers fire in name order, so this one
--    runs before trg_social_message_keys redirects a merged (tombstone)
--    conversation to its canonical one; the target already lives in the
--    canonical conversation (008 moved it), the lookup missed and the
--    reaction was DROPPED. The function now resolves the canonical
--    conversation itself (merged_into, one level, like 008's redirect) and
--    notifies with it. Everything else is prod's body verbatim.
--
-- 2. is_deleted = TRUE for the WhatsApp rows revoked before PR-3: the old
--    inbound revoke only set status = 'deleted' (1,050 rows on 01-10). Same
--    shape as the connector's markMessageRevoked: content kept, metadata gets
--    deleted_at (= status_at, when the revoke was recorded) and
--    deleted_source 'whatsapp' unless already there, plus deleted_backfill
--    '015' so these rows can be told apart. status does not change, so
--    messages_notify_status sends nothing.
--
-- 3. whatsapp_message_reactions (011) from the historical messages.reactions
--    JSONB ({emoji: [reactor, ...]}, 13k WhatsApp messages): one row per
--    (account, target, reactor), emoji, removed = false, reaction_wa_message_id
--    and reacted_at NULL (the JSONB never kept them), updated_at = the target
--    message's time (the reaction is not older; now() would put 18k old rows
--    first in "newest reactions"). from_me = the reactor is this account.
--    The "me" reactor (outbound reactions) becomes the account's own jid: the
--    sender_wa_id of most of its OUTBOUND messages (share >= 50 %, already
--    namespaced like every jid of that account); an account without one
--    keeps its "me" entries out (counted in the NOTICE). The table's own
--    trigger files a phone jid under its LID (social_contact_aliases) and the
--    conversation under the target's. ON CONFLICT DO NOTHING: every row
--    already there was written live by the connector and is at least as new
--    as the JSONB (the connector upsert, in turn, always replaces a row whose
--    reacted_at is NULL), and the whatsapp_message_reactions_current view
--    prefers a row with reacted_at over one without for the same person.
--
-- Locks: this file runs in ONE transaction (migrate.ts). No DDL takes a lock
-- on messages in a DB that already has the trigger (prod): it is created only
-- when missing — a DROP TRIGGER + CREATE TRIGGER would hold ACCESS EXCLUSIVE
-- on messages until COMMIT. The backfills read messages in id order, 5,000
-- matching rows per statement; the only rows locked in messages are the ones
-- step 2 updates. lock_timeout makes a blocked run fail (and the PreSync Job
-- retry) instead of queueing writers behind it.
--
-- Idempotent: every step skips what is already done. No new table in this
-- file, so migrate.ts never baselines it: it runs once and is recorded.

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.merge_inbound_reaction()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_id   bigint;
  reactor     text;
  target_rxn  jsonb;
  emoji       text;
  emoji_users jsonb;
  k           text;
  current_arr jsonb;
  target_conv text;
BEGIN
  -- Only handle REACTION inserts
  IF NEW.message_type IS DISTINCT FROM 'REACTION' THEN
    RETURN NEW;
  END IF;

  emoji   := COALESCE(NULLIF(NEW.content, ''), NULL);
  reactor := CASE
    WHEN NEW.direction = 'OUTBOUND' THEN 'me'
    ELSE NEW.sender_wa_id
  END;

  -- 015: the canonical conversation. This trigger fires before
  -- trg_social_message_keys redirects a merged one, and the target was moved
  -- there by the merge.
  SELECT COALESCE(c.merged_into, c.id) INTO target_conv
  FROM conversations c
  WHERE c.id = NEW.conversation_id;
  target_conv := COALESCE(target_conv, NEW.conversation_id);

  -- Find target by wa_message_id within the same conversation
  SELECT id, COALESCE(reactions, '{}'::jsonb) INTO target_id, target_rxn
  FROM messages
  WHERE conversation_id = target_conv
    AND wa_message_id = NEW.reply_to_message_id
  LIMIT 1;

  IF target_id IS NULL THEN
    -- Target not in DB (history gap). Drop the reaction row to keep chat clean.
    RETURN NULL;
  END IF;

  -- Strip reactor from every emoji bucket first (one-reaction-per-user).
  FOR k IN SELECT jsonb_object_keys(target_rxn) LOOP
    current_arr := target_rxn -> k;
    IF jsonb_typeof(current_arr) = 'array' THEN
      target_rxn := jsonb_set(target_rxn, ARRAY[k],
        COALESCE(
          (SELECT jsonb_agg(elem) FROM jsonb_array_elements(current_arr) elem WHERE elem <> to_jsonb(reactor)),
          '[]'::jsonb
        ));
    END IF;
    -- Drop empty arrays
    IF target_rxn -> k = '[]'::jsonb THEN
      target_rxn := target_rxn - k;
    END IF;
  END LOOP;

  -- If new emoji is null → un-react (already removed above). Otherwise add.
  IF emoji IS NOT NULL THEN
    emoji_users := COALESCE(target_rxn -> emoji, '[]'::jsonb);
    IF NOT (emoji_users @> to_jsonb(reactor)) THEN
      emoji_users := emoji_users || jsonb_build_array(reactor);
    END IF;
    target_rxn := jsonb_set(target_rxn, ARRAY[emoji], emoji_users, true);
  END IF;

  UPDATE messages SET reactions = target_rxn WHERE id = target_id;

  -- Tell SSE listeners the target was updated so the UI re-fetches.
  PERFORM pg_notify('message_updated', json_build_object(
    'id', target_id, 'conversation_id', target_conv, 'kind', 'reactions'
  )::text);

  -- Skip the INSERT — reaction rows have no business in the chat stream.
  RETURN NULL;
END;
$function$;

-- 2. Revokes recorded before PR-3.
DO $$
DECLARE
  v_batch CONSTANT INTEGER := 5000;
  v_last BIGINT := 0;
  v_n BIGINT;
  v_total BIGINT := 0;
BEGIN
  LOOP
    WITH b AS (
      SELECT id FROM messages
       WHERE id > v_last AND platform = 'whatsapp' AND status = 'deleted'
         AND is_deleted IS DISTINCT FROM TRUE
       ORDER BY id
       LIMIT v_batch
    ), u AS (
      UPDATE messages m
         SET is_deleted = TRUE,
             metadata = jsonb_strip_nulls(jsonb_build_object(
                          'deleted_at', to_char(m.status_at AT TIME ZONE 'UTC',
                                                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                          'deleted_source', 'whatsapp'))
                        || COALESCE(m.metadata, '{}'::jsonb)
                        || jsonb_build_object('deleted_backfill', '015')
        FROM b
       WHERE m.id = b.id
      RETURNING m.id
    )
    SELECT count(*), max(id) INTO v_n, v_last FROM u;
    EXIT WHEN v_n = 0;
    v_total := v_total + v_n;
  END LOOP;
  RAISE NOTICE '015: % old WhatsApp revokes flagged is_deleted', v_total;
END $$;

-- 3. messages.reactions → whatsapp_message_reactions.
DO $$
DECLARE
  v_batch CONSTANT INTEGER := 5000;
  v_last BIGINT := 0;
  v_msgs BIGINT;
  v_entries BIGINT;
  v_ins BIGINT;
  v_me_skipped BIGINT;
  v_t_msgs BIGINT := 0;
  v_t_entries BIGINT := 0;
  v_t_ins BIGINT := 0;
  v_t_me_skipped BIGINT := 0;
  v_acc TEXT[];
  v_own TEXT[];
BEGIN
  -- Own jid per account: the sender of most of its outbound messages.
  SELECT COALESCE(array_agg(account_id), '{}'), COALESCE(array_agg(sender_wa_id), '{}')
    INTO v_acc, v_own
    FROM (
      SELECT account_id, sender_wa_id, count(*) AS c,
             sum(count(*)) OVER (PARTITION BY account_id) AS t,
             row_number() OVER (PARTITION BY account_id ORDER BY count(*) DESC, sender_wa_id) AS rn
        FROM messages
       WHERE platform = 'whatsapp' AND direction = 'OUTBOUND'
         AND account_id IS NOT NULL AND COALESCE(sender_wa_id, '') <> ''
       GROUP BY account_id, sender_wa_id
    ) s
   WHERE rn = 1 AND c * 2 >= t;
  RAISE NOTICE '015: own jids %', (SELECT jsonb_object_agg(a, o) FROM unnest(v_acc, v_own) x(a, o));

  LOOP
    WITH b AS (
      SELECT id, account, account_id, wa_message_id, conversation_id, wa_timestamp, reactions
        FROM messages
       WHERE id > v_last AND platform = 'whatsapp'
         AND reactions IS NOT NULL AND reactions <> '{}'::jsonb
       ORDER BY id
       LIMIT v_batch
    ), e AS (
      SELECT b.id, b.account, b.account_id, b.wa_message_id, b.conversation_id, b.wa_timestamp,
             r.emoji, u.reactor, o.own
        FROM b
        CROSS JOIN LATERAL jsonb_each(b.reactions) r(emoji, users)
        CROSS JOIN LATERAL jsonb_array_elements_text(
                     CASE WHEN jsonb_typeof(r.users) = 'array' THEN r.users ELSE '[]'::jsonb END) u(reactor)
        LEFT JOIN unnest(v_acc, v_own) o(account_id, own) ON o.account_id = b.account_id
       WHERE r.emoji <> '' AND COALESCE(u.reactor, '') <> ''
    ), ins AS (
      INSERT INTO whatsapp_message_reactions
             (account, account_id, target_wa_message_id, reactor_jid, conversation_id,
              emoji, removed, from_me, reacted_at, updated_at)
      SELECT e.account, e.account_id, e.wa_message_id,
             CASE WHEN e.reactor = 'me' THEN e.own ELSE e.reactor END,
             e.conversation_id, e.emoji, FALSE,
             e.reactor = 'me' OR COALESCE(e.reactor = e.own, FALSE), NULL, e.wa_timestamp
        FROM e
       WHERE e.reactor <> 'me' OR e.own IS NOT NULL
       ORDER BY e.id, e.emoji
      ON CONFLICT (account, target_wa_message_id, reactor_jid) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM b), (SELECT max(id) FROM b), (SELECT count(*) FROM e),
           (SELECT count(*) FROM ins), (SELECT count(*) FROM e WHERE e.reactor = 'me' AND e.own IS NULL)
      INTO v_msgs, v_last, v_entries, v_ins, v_me_skipped;
    EXIT WHEN v_msgs = 0;
    v_t_msgs := v_t_msgs + v_msgs;
    v_t_entries := v_t_entries + v_entries;
    v_t_ins := v_t_ins + v_ins;
    v_t_me_skipped := v_t_me_skipped + v_me_skipped;
  END LOOP;
  RAISE NOTICE '015: reactions of % messages: % entries, % rows inserted, % "me" without own jid skipped',
    v_t_msgs, v_t_entries, v_t_ins, v_t_me_skipped;
END $$;

-- 1b. The trigger, prod's definition, created only where it is missing (a
-- fresh DB): see "Locks" above.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_merge_inbound_reaction'
                    AND tgrelid = 'public.messages'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_merge_inbound_reaction BEFORE INSERT ON public.messages
      FOR EACH ROW EXECUTE FUNCTION merge_inbound_reaction();
  END IF;
END $$;
