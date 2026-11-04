# Evidencia INFRA-345 — social_moderate_members (P2 de INFRA-218)

Rama: INFRA-345-moderate-members · Repo: pocharlies-org/k8s-socialmedia-pocharlies · Base: origin/deploy/prod (0b1c94b, P1 ya fusionada)

## Suite de tests de mcp-server

Comando: `cd mcp-server && npx jest` (tras `pnpm --filter @mcp-socialmedia/shared run build`), ejecutado en el worktree de la rama.

```
Test Suites: 7 skipped, 75 passed, 75 of 82 total
Tests:       19 skipped, 935 passed, 954 total
Snapshots:   0 total
Time:        24.499 s
```

PASS/FAIL: PASS — 935 tests en verde, 0 fallos (los 7 suites / 19 tests skipped son los ya skippeados en el tronco).

## Build y contrato

- `npm run build` (tsc): limpio, sin errores.
- `pnpm contract:check`: `Socialmedia contract OK: sha256:aff4491145fc4a3ad34dc61a00c19ee93b2889ae2af98faa88e6fbe3fec2ea15 (78 tools)`.
- `git diff --numstat contracts/socialmedia-tools.json`: +329/−1 — la única línea eliminada es la del digest; las 77 entradas previas intactas (diff aditivo, criterio del plan C4: aditivo, no un número fijo — el «36/35» del spec quedó obsoleto con 77 herramientas en trunk).

## Criterios (00-spec.md de INFRA-345)

- C1 (schema): `inputSchema.properties.action.enum` = exactamente [ban, unban, kick, restrict, unrestrict, get_admin_rights] — test «C1» verde.
- C2 (confirm): 3 acciones × {ausente, false} → `confirmation_required` con 0 llamadas al conector — 6 tests verdes.
- C6 (invalid_target): `user_id: "@nombre-que-no-existe"` y `chat_id: "abc"` → `invalid_target` con «debe ser id numérico de Telegram», 0 llamadas al conector — 2 tests verdes.
- C4 (reason): ausente en ban → `invalid_request` antes del conector; en unban/get_admin_rights no se exige — test verde.
- C5 (restriction/until): enum cerrado en el schema (AJV lo valida antes del handler); `until` con `format: date-time` y solo en ban/restrict (allOf) — test del enum verde; el resto, schema-enforced.
- C6 (platform): channel ≠ telegram → `unsupported_platform` sin llamar al conector — test verde.
- C7 (enrutado): dos `account_id` → `tgUrl` recibe el recibido (http://telegram-personal / http://telegram-professional) — test verde.
- C8 (contrato): entrada aditiva regenerada con `pnpm contract:generate`; commit con trailer `Contract-Change: add social_moderate_members`.
- Auditoría (INFRA-347 absorbido): fila por intento (INSERT 'pending' antes del conector con el principal del gateway como actor, UPDATE al `ok` o al código canónico con el `code` TL); fallo de escritura → `audit_unavailable` con 0 llamadas al conector; `get_admin_rights` no audita — 4 tests verdes.
- Documentación: la doc de herramientas del repo es la generada (`contracts/socialmedia-tools.md`), regenerada con la herramienta nueva; ningún otro doc enumera tools (medido: `grep -rln social_manage_forum docs/ README.md` sin coincidencias).

## Verificación en vivo

Fuera de esta PR: la verificación en vivo es INFRA-348 (P5), y la publicación en el gateway es INFRA-346 (P3).
