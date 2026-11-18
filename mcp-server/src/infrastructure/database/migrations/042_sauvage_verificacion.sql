-- 042 — Bot diario de verificacion facial del grupo Sauvage verificado
-- (INFRA-745, parte A de INFRA-125). El bot es el unico escritor de estas dos
-- tablas; no toca ninguna del conector.
--
-- savage_verdicts: una fila por (cuenta, miembro, pasada). Historial: cada
-- veredicto guarda su texto bruto del modelo para poder auditar despues
-- (criterio de la epica). "Estado actual de un miembro" = su fila mas nueva
-- por (account, user_id, audited_at DESC), que es el indice que se pide abajo.
-- C6 (persistencia): al arrancar cada pasada el bot hace un SELECT count(*) y
-- loggea `estado cargado: N veredictos previos`; tras un pod matado a mitad,
-- la pasada siguiente ademas salta los miembros ya auditados hoy.
--
-- savage_actions: registro append-only de lo que hizo la parte B (aviso,
-- expulsion, readmision). Nace aqui vacia y sin consumidores: INFRA-746 es
-- quien escribe. C7 (anulacion manual) consulta la accion mas nueva por
-- miembro por (user_id, at DESC).
--
-- EXPAND only, idempotente (IF NOT EXISTS). El bot NO crea las tablas: sin
-- ellas el CronJob falla ruidoso (relation does not exist) y GitOps lo
-- arregla, como con 040.

CREATE TABLE IF NOT EXISTS savage_verdicts (
  account    TEXT NOT NULL,                    -- cuenta lectora (professional)
  user_id    TEXT NOT NULL,                    -- id numerico de Telegram del miembro
  verdict    TEXT NOT NULL CHECK (verdict IN ('cara', 'sin_cara', 'dudoso', 'no_auditar')),
  raw_text   TEXT,                             -- texto bruto del modelo (o motivo del fallo)
  audited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, user_id, audited_at)
);

-- Ultima pasada de un miembro (reanudacion de C6, informe C5).
CREATE INDEX IF NOT EXISTS idx_savage_verdicts_member_latest
  ON savage_verdicts (account, user_id, audited_at DESC);

CREATE TABLE IF NOT EXISTS savage_actions (
  user_id    TEXT NOT NULL,
  action     TEXT NOT NULL,                    -- dm | ban | unban | add | link (parte B)
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed  BOOLEAN NOT NULL DEFAULT false,
  motivo     TEXT,
  PRIMARY KEY (user_id, at)
);

-- Ultima accion de un miembro (C7: anulacion manual del dueño).
CREATE INDEX IF NOT EXISTS idx_savage_actions_user_latest
  ON savage_actions (user_id, at DESC);
