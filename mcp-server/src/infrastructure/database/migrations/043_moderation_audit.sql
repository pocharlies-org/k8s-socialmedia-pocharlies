-- 043 — moderation_audit (INFRA-218 P2 / INFRA-345, dictamen CTO §4). El MCP
-- server es el único escritor: canonicalModerateMembers abre la fila ANTES de
-- mutar (outcome 'pending', para que un intento cortado entre auditoría y
-- conector quede visible) y la cierra con 'ok' o con el código canónico del
-- error (not_admin, rate_limited, telegram_error…). Una fila por intento de
-- mutación, también los fallos; get_admin_rights es lectura y no audita.
-- Si esta fila no se puede escribir, la mutación se deniega (audit_unavailable).
--
-- actor: el principal que afirma el gateway (x-user-sub / x-user-name).
-- Límite conocido del dictamen §4: con el bearer compartido de /social ese
-- header es falsificable; arreglarlo es otra épica.
--
-- EXPAND only, idempotente (IF NOT EXISTS). El MCP NO crea la tabla si falta:
-- sin ella toda mutación falla ruidosa (audit_unavailable) y GitOps lo arregla,
-- como con 040.

CREATE TABLE IF NOT EXISTS moderation_audit (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor          TEXT,                                -- sub / preferred_username del gateway
  account_id     TEXT REFERENCES social_accounts(id), -- ADR 0001: la cuenta, nunca el prefijo de un id
  platform       TEXT NOT NULL DEFAULT 'telegram',    -- único valor hoy (dictamen §1)
  chat_id        TEXT NOT NULL,                       -- id numérico (marcado -100… incluido)
  target_user_id TEXT NOT NULL,                       -- id numérico del miembro moderado
  action         TEXT NOT NULL CHECK (action IN ('ban', 'unban', 'kick', 'restrict', 'unrestrict')),
  restriction    TEXT CHECK (restriction IN ('mute', 'no_media', 'no_invite', 'read_only')),
  "until"        TEXT,                                -- ISO-8601 tal cual la pidió el llamante
  reason         TEXT,
  outcome        TEXT NOT NULL DEFAULT 'pending',     -- pending → ok | código canónico de error
  telegram_error TEXT                                 -- código TL original (FOO_BAR), nunca outcome_unknown
);

-- Historial de un chat (lo que se consulta al auditar una moderación).
CREATE INDEX IF NOT EXISTS idx_moderation_audit_chat_ts
  ON moderation_audit (chat_id, ts DESC);

-- Qué hizo un actor (responsabilidad del principal).
CREATE INDEX IF NOT EXISTS idx_moderation_audit_actor_ts
  ON moderation_audit (actor, ts DESC);
