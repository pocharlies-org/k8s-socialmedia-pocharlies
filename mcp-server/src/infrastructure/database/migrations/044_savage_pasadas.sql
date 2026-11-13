-- 044 — savage_pasadas (INFRA-745, defecto de C1 encontrado por qa tras el
-- cierre del story: veredicto nota-qa-c1.md de INFRA-125).
--
-- C1 exige «cada pasada en su propia sesion de opencode», pero el id `ses_`
-- solo vivia en los logs del pod y savage-pod-reaper (kube-system,
-- SUCCEEDED_TTL_SECONDS=7200) los borra a las 2 h del exito: la evidencia no
-- era recuperable retroactivamente. El bot escribe ahora UNA FILA POR PASADA
-- con el `ses_` de su sesion (resuelto del almacenamiento de opencode del pod:
-- sauvage-verificacion/src/sesion-opencode.ts) y su fecha/hora. El grep de
-- logs sigue valiendo solo el mismo dia antes del reaper.
--
-- sesion_id NULL = pasada sin ses_ resoluble (almacenamiento de opencode fuera
-- del sitio esperado); la fila existe igual: la pasada ocurrio.
--
-- EXPAND only, idempotente (IF NOT EXISTS). El bot NO crea la tabla: sin ella
-- la pasada sigue y loggea el fallo de registro (la evidencia es metadata; no
-- puede tumbar el informe), y GitOps la aplica con el Job PreSync
-- whatsapp-mcp-migrate (ledger schema_migrations).

CREATE TABLE IF NOT EXISTS savage_pasadas (
  id        BIGSERIAL PRIMARY KEY,
  account   TEXT NOT NULL,                     -- cuenta del barrido (professional)
  sesion_id TEXT,                              -- ses_ de la sesion de opencode (NULL = sin resolver)
  pasada_at TIMESTAMPTZ NOT NULL DEFAULT NOW() -- fecha/hora de la pasada
);

-- Pasadas en orden (C1: tres consecutivas, cada una con su fila y su id distinto).
CREATE INDEX IF NOT EXISTS idx_savage_pasadas_at
  ON savage_pasadas (pasada_at DESC);
