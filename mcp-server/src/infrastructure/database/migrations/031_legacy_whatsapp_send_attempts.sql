-- Preserve the legacy NAS attempts while exposing the prod 010 store contract.
DO $upgrade$
DECLARE c record;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='whatsapp_send_attempts' AND column_name='token_hash') THEN
    ALTER TABLE whatsapp_send_attempts ADD COLUMN IF NOT EXISTS key_hash text;
    ALTER TABLE whatsapp_send_attempts ADD COLUMN IF NOT EXISTS account_id text REFERENCES social_accounts(id);
    ALTER TABLE whatsapp_send_attempts ADD COLUMN IF NOT EXISTS error text;
    ALTER TABLE whatsapp_send_attempts ADD COLUMN IF NOT EXISTS updated_at timestamptz;
    UPDATE whatsapp_send_attempts SET key_hash=COALESCE(key_hash,token_hash),
      updated_at=COALESCE(updated_at,sent_at,created_at);
    ALTER TABLE whatsapp_send_attempts ALTER COLUMN key_hash SET NOT NULL;
    ALTER TABLE whatsapp_send_attempts ALTER COLUMN updated_at SET NOT NULL;
    ALTER TABLE whatsapp_send_attempts ALTER COLUMN updated_at SET DEFAULT now();
    ALTER TABLE whatsapp_send_attempts ALTER COLUMN message_id DROP NOT NULL;
    FOR c IN SELECT conname FROM pg_constraint
      WHERE conrelid='whatsapp_send_attempts'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
      EXECUTE format('ALTER TABLE whatsapp_send_attempts DROP CONSTRAINT %I', c.conname);
    END LOOP;
    ALTER TABLE whatsapp_send_attempts ADD CONSTRAINT whatsapp_send_attempts_status_check
      CHECK(status IN ('prepared','pending','sent','failed'));
    CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_send_attempts_account_key_hash
      ON whatsapp_send_attempts(account,key_hash);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_send_attempts_created
      ON whatsapp_send_attempts(account,created_at);
    EXECUTE $function$
      CREATE OR REPLACE FUNCTION social_legacy_send_attempt_keys() RETURNS trigger
      LANGUAGE plpgsql AS $body$
      DECLARE s record;
      BEGIN
        NEW.key_hash := COALESCE(NEW.key_hash, NEW.token_hash);
        NEW.token_hash := COALESCE(NEW.token_hash, NEW.key_hash);
        NEW.updated_at := COALESCE(NEW.updated_at, NEW.sent_at, NEW.created_at, now());
        IF NEW.account_id IS NULL THEN
          s := social_split_legacy_id(NEW.key_hash, NEW.account, 'whatsapp');
          NEW.account_id := s.account_id;
        END IF;
        RETURN NEW;
      END $body$;
    $function$;
    DROP TRIGGER IF EXISTS trg_social_legacy_send_attempt_keys ON whatsapp_send_attempts;
    CREATE TRIGGER trg_social_legacy_send_attempt_keys BEFORE INSERT OR UPDATE
      ON whatsapp_send_attempts FOR EACH ROW EXECUTE FUNCTION social_legacy_send_attempt_keys();
    UPDATE whatsapp_send_attempts t SET account_id=a.id
      FROM social_accounts a WHERE t.account_id IS NULL
        AND a.channel='whatsapp' AND a.legacy_namespace=t.account;
  END IF;
END $upgrade$;
