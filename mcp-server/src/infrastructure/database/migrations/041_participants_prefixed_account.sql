-- SKIRM-261: the runner applies this right before 039 (see migrate.ts). 039
-- materializes the author's `whatsapp_contacts` view keyed by (account, jid
-- without its account prefix) and aborts on a duplicate key by design. Prod
-- (23-10) held one participant written under the wrong legacy account:
-- id 'professional:tg_3401402332' with account='personal' while its
-- account_id is 'telegram:professional'; the view then yields
-- (personal, tg_3401402332) twice. A namespaced id carries its account in the
-- prefix (the rule every other prefixed row follows), so realign `account` to
-- it when account_id confirms that same account. Idempotent; touches only the
-- mismatched rows; skipped on schemas without account_id (pre-008).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'participants' AND column_name = 'account_id'
  ) THEN
    UPDATE participants
       SET account = split_part(id, ':', 1)
     WHERE position(':' IN id) > 0
       AND account IS DISTINCT FROM split_part(id, ':', 1)
       AND split_part(account_id, ':', 2) = split_part(id, ':', 1);
  END IF;
END $$;
