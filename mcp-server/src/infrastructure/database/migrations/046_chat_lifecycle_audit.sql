-- 046 — moderation_audit para el ciclo de vida de chats (INFRA-278). EXPAND only,
-- idempotente: deleteChat y leaveChat auditan con el mismo mecanismo que la
-- moderación de miembros (openModerationAudit/closeModerationAudit en server.ts)
-- pero no tienen miembro moderado: target_user_id pasa a poder ser NULL y el
-- CHECK de action admite las dos acciones nuevas. Ninguna fila existente cambia.

ALTER TABLE moderation_audit DROP CONSTRAINT IF EXISTS moderation_audit_action_check;
ALTER TABLE moderation_audit ADD CONSTRAINT moderation_audit_action_check
  CHECK (action IN ('ban', 'unban', 'kick', 'restrict', 'unrestrict', 'deleteChat', 'leaveChat'));
ALTER TABLE moderation_audit ALTER COLUMN target_user_id DROP NOT NULL;
