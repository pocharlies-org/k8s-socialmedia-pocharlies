# Evidencia INFRA-278 (worktree, 2026-11-19T21:45:47Z)

Comando: pnpm --filter @mcp-socialmedia/telegram-connector test (node:test, tsx)
Resultado: PASS — 141 tests, 133 pass, 0 fail, 8 skipped (skip previos en el trunk)

Comando: pnpm --filter @mcp-socialmedia/server test (jest)
Resultado: PASS — 950 tests, 931 pass, 19 skipped (previos), 0 fail

Comando: pnpm --filter @mcp-socialmedia/server test -- tool-registry
Resultado: PASS — 19/19 (C1 enum, C2 guardas, C4 auditoría)

Comando: pnpm contract:check
Resultado: OK — sha256:1acdfbeccf2bb8c18ebd922b91dc478d29b9231779f6fc80f93010c281b90e5c (79 tools)

Comando: tsc --noEmit (server y telegram-connector) + eslint de los ficheros tocados
Resultado: 0 errores

## Criterios
- C1: PASS — enum social_manage_chat = setTitle|setDescription|setPhoto|setForumEnabled|deleteChat|leaveChat (tool-registry.contract.spec.ts).
- C2: PASS — confirm ausente/false o idempotencyKey ausente/vacío → confirmation_required con 0 llamadas al conector y 0 filas de auditoría (tool-registry.chat-lifecycle.spec.ts).
- C3: PASS — DELETE/POST /api/public/chats/…/delete|leave → 404 firmado y la lista ROUTES pública sin cambios (public-routes.test.ts).
- C4: PASS — INSERT pending antes del conector y UPDATE ok/código en cada intento; fallo del INSERT → audit_unavailable con 0 llamadas (tool-registry.chat-lifecycle.spec.ts; rutas y tabla canónica en chat-lifecycle-routes.test.ts).
- C5: PASS — e2e createGroup → addMembers → participants → kick → deleteChat con ids numéricos en cada paso y deleteChannel con el id marcado (chat-lifecycle-routes.test.ts).
- C6: pendiente post-fusión (imagen + pin + verificación en vivo, documentado en 50-entrega.md).
