# Evidencia · feat/skirm-107-account-guard (SKIRM-107)

Dónde: worktree `dev/SKIRM-107-developer` sobre `origin/deploy/prod` (ca667c6), Node/pnpm del x86, `pnpm install --frozen-lockfile`.

## ROJO: specs nuevas contra el código de `origin/deploy/prod` (sin el guard)
Comando: `cd mcp-server && npx jest --verbose src/application/message-ingestion.service.spec.ts src/application/instagram-ingestion.service.spec.ts src/application/search.service.account-guard.spec.ts src/infrastructure/jobs/embedding-job.spec.ts src/domain/account.spec.ts`
Resultado: **FAIL · 12 fallan, 36 pasan, 48 en total**

```
    ✕ round trips an arbitrary third account and does not collide
    ✕ refuses an id namespaced to another account (SKIRM-107 C1)
    ✕ an id that already names an account is that account's alone: no throw, no widening
    ✕ with an account, an id namespaced to ANOTHER account is refused, not searched
    ✕ an id of the disabled namespace is looked up as is
    ✕ a chat id that names an account asks only that account's instance, without throwing
  ✕ SKIRM-107: un waMessageId namespaced a OTRA cuenta no se busca bajo la del evento
    ✕ an event of professional carrying a leila conversationId is refused, logged and writes nothing
    ✕ an event of professional carrying a leila senderWaId is refused, logged and writes nothing
    ✕ an event of professional carrying a leila waMessageId is refused, logged and writes nothing
    ✕ the personal account refuses an id namespaced to another account too
    ✕ a historical id of the disabled namespace is recognised, so it cannot be refiled elsewhere
Test Suites: 4 failed, 1 passed, 5 total
Tests:       12 failed, 36 passed, 48 total
```

## VERDE: las mismas specs con el guard y los dos ajustes de search.service.ts
Resultado: **PASS · 49 de 49** (el caso `messagesById` se añadió después del rojo: contra el `search.service.ts` del tronco con el guard puesto también cae). `account-isolation`/`whatsapp-updates-isolation` del fork: ver `50-entrega.md`, no aplican.

## Suite completa
- `pnpm --filter ./mcp-server test` → exit 0, `Test Suites: 1 skipped, 54 passed`, `Tests: 8 skipped, 663 passed, 671 total`.
- `pnpm -r --no-bail test` → exit 0 (mcp-server 662 + 1 de la última spec añadida; whatsapp-web 537, telegram 66, instagram 41, synapse-bridge 40, todos `fail 0`). Un primer `pnpm -r test` cayó en `connectors/whatsapp-web credential-session.test.ts` («saveCreds bursts coalesce», `2 !== 1`, temporizado): fichero no tocado, 3 de 3 pasadas aisladas con `# fail 0`, y la segunda pasada completa verde.
- `pnpm contract:check` → `Socialmedia contract OK: sha256:e30a4521…c0993d (73 tools)`; el digest de `contracts/socialmedia-tools.json` es idéntico al de `origin/deploy/prod`.
- `python3 scripts/render-connectors.py --check` → exit 0. `git diff` de `pnpm-lock.yaml`, `package.json`, `.github/`, `Dockerfile`: vacío.

## Criterios
- C1: `pnpm --filter ./mcp-server test -- account` → 5 suites, 58 pasan (`account.spec.ts` con los 5 casos de la spec).
- C2: ver «Fork vs prod» en `50-entrega.md`.
- C3: `message-ingestion.service.spec.ts` (3 cuentas, 3 campos, deshabilitada) + caso en `instagram-ingestion.service.spec.ts`.
- C4: `search.service.account-guard.spec.ts`; `server.search-messages.spec.ts` sin tocar (`git diff` vacío), verde.
- C5: `rg "Cross-account identifier|namespaceAccountId"` fuera de specs → solo `mcp-server/src/domain/account.ts`.
- C6: contract:check verde, 73 tools, digest igual.
- C7: lockfile sin cambios; `Co-authored-by` y rutas de origen en el commit.
- C8: tabla de llamadores en `50-entrega.md`.
