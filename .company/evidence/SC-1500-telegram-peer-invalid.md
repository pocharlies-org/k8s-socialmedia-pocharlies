# Evidencia SC-1500 — telegram-connector: bucle PEER_ID_INVALID (CRIT-7625)

Rama: `SC-1500-telegram-peer-invalid` (base `origin/deploy/prod`).
Ejecutado en: worktree `.claude/worktrees/SC-1500-peer-invalid` (node 22, pnpm 11.18).

## Reproducción (test contra el código actual, antes del fix)

```
$ npx tsx --test src/peer-resilience.test.ts   # connectors/telegram
# tests 4 / pass 1 / fail 3
```

Los 3 fallos son exactamente el síntoma del bug: un peer no resoluble aborta la
enumeración de diálogos (`getDialogs` rechaza → `GET /dialogs` 500 → el ciclo de
backfill de telegram-sync importa CERO chats) y un peer ausente del input cache
hace fallar `getMessages` para siempre (nunca se reindexa).

## Tras el fix

```
$ npx tsx --test src/peer-resilience.test.ts
# tests 4 / pass 4 / fail 0

$ pnpm test   # suite completa del connector
# tests 126 / pass 118 / fail 0 / skipped 8
```

Los 8 skipped son pre-existentes (tests de `send-idempotency.test.ts` gated por
`TELEGRAM_TEST_DATABASE_URL`, línea 144).

## Criterios del bug

- **C1 — un peer desconocido/inválido no aborta el ciclo de fetch (se omite y se loguea, o se resuelve/reindexa el input cache):** CUMPLE. `getDialogs` omite + loguea el diálogo con peer no resoluble y, si la API corta la enumeración a mitad, devuelve los diálogos leídos (rechaza solo si no leyó ninguno, para que el ciclo reintente); `getMessages` reindexa el input cache vía `client.getPeer` (mtcute `resolvePeer` → API) y reintenta una vez. Probado por `src/peer-resilience.test.ts` (4/4) sin regresión (118/118).
- **C2 — conversation_replies_total vuelve a crecer y CRIT-7625 se descarga solo:** NO VERIFICABLE desde este repo. El consumidor del ciclo (autopilot `synapse-adapter-conversation`, ns `synapse`) NO está desplegado en el clúster: no existe su Deployment y la Application ArgoCD `synapse` está `OutOfSync` (comprobado 2026-11-08 con kubectl). Esta PR elimina el abort en la fuente (connector); la reactivación del contador requiere además el despliegue de los adapters de synapse, fuera del repo del bug. Reportado al supervisor.

## Reutilizado

- `connectors/telegram/src/telegram-client.ts` — fix en los dos métodos existentes (`getDialogs`, `getMessages`); sin clases nuevas.
- Patrón de test `get-messages-pagination.test.ts` (wrapper sobre `Object.create(TelegramClientWrapper.prototype)` con client fake) — reutilizado tal cual en `peer-resilience.test.ts`.
- `withDownloadDeadline` / `telegramReadClient` existentes, sin tocar.
