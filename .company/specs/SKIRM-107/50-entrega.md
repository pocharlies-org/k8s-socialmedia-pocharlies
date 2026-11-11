Rol: developer · Fecha: 2026-10-08 · Sesión: 715ef7e4-8c79-4f49-a12d-59a7c4339ea7 · Estado: LISTO

# SKIRM-107 · F5 guard de cuentas en accountKey

PR: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/230 (rama `SKIRM-107-guard-cuentas-r2` → `deploy/prod`, rebasada sobre `cb1fe60` / #228; commits de código `5bba8ed` (guard, con co-autor) y `a7a2c69` (test de `getMessagesByUser`); el commit de esta nota va encima)

## Qué se hizo

- `mcp-server/src/domain/account.ts`: `accountKey` lanza `AccountRegistryError('Cross-account identifier')` si el id ya está namespaced a otra cuenta, `personal` incluida. Forma exacta del architect, sin `normalizeAccount`.
- `mcp-server/src/application/search.service.ts`: `inEveryNamespace` devuelve `[id]` si el id ya lleva un namespace (3 líneas, como pedía la historia) y **`brainScopes`** pregunta solo al scope de la cuenta cuyo prefijo lleva el id cuando no hay cuenta (5 líneas; ver «Desvío»).
- Tests nuevos o ampliados: `account.spec.ts`, `search.service.namespaces.spec.ts` (nuevo), `message-ingestion.service.spec.ts` (nuevo), `instagram-ingestion.service.spec.ts`, `embedding-job.spec.ts`, `server.account-guard.spec.ts` (nuevo).
- `ARCHITECTURE.md` §4: `accountKey` es la única copia con guard; `connectors/whatsapp-web/src/db-writer.ts` `accountKey` y `connectors/telegram-sync/sync/db.py` `account_key` figuran como espejos sin guard, con el motivo (cada proceso escribe solo su cuenta por `CONNECTOR_ACCOUNT` y los ids vienen del proveedor).
- `.company/changes/skirm-107-guard-cuentas.md`: antes/ahora/quién se mueve/decisión (el comportamiento visible para un cliente de `social_*` cambia: error en vez de resultado vacío).

## Desvío respecto a la spec (decisión tomada, para el architect)

La spec y la nota del architect solo ajustan `inEveryNamespace`. Medido: con ese ajuste y el guard, `SearchService.semanticSearch('…', { chatId: 'leila:34600@s.whatsapp.net' })` sin cuenta **sigue lanzando** `Cross-account identifier` desde `brainScopes` (`search.service.ts:367`), porque recorre todos los namespaces con `accountKey(account, chatId)`. Es la misma búsqueda sin cuenta que el hunk quería proteger (el MCP devuelve `conversationId` prefijado en los resultados y el cliente puede devolverlo como `target`). Se corrige en el mismo PR con las mismas reglas: sin cuenta y con id prefijado, solo el scope de esa cuenta (no se ensancha); con cuenta explícita y id ajeno, lanza. Test: `search.service.namespaces.spec.ts › account-less semantic search`. Si el architect lo quiere fuera, es borrar 5 líneas y 2 tests.

## Fork: cuadro «falla / ya pasa» (C2)

Ejecutados contra `origin/deploy/prod@ca667c6` con la versión del fork (`9ccd189`, mismos ficheros que `2efbbf8`):

| Test del fork | Contra prod | Decisión |
|---|---|---|
| `whatsapp-updates-isolation.spec.ts` | FALLA al compilar: `TS2307 ../domain/whatsapp-surface` y `TS2339 handleMessageReceived` no existe en `EmbeddingJob` | no se adopta: prueba superficie del fork que prod no tiene |
| `account-isolation.integration.spec.ts` | SKIPPED (3): exige `ACCOUNT_INTEGRATION=true`, una BD `account_isolation_test` desechable y `accounts.fixture.json` del fork (cuenta `secondary`, Instagram `other_ig`); `ci.yml` no tiene Postgres para mcp-server | no se adopta: no es ejecutable aquí ni en CI. Ningún caso suyo prueba el guard; la idea de su caso 1 (mismo id de proveedor en dos cuentas no colisiona) queda cubierta en `message-ingestion.service.spec.ts` |
| hunk de `account.spec.ts` (`accountKey('secondary','arbitrary_3:same')` lanza) | no existe en prod (usa fixture del fork) | adoptado en `account.spec.ts › cross-account guard` con las cuentas de prod |

No se probó contra una BD real (no hay Postgres con pgvector en este host): el guard se prueba con la BD simulada que usan los demás specs.

## Rojo → verde

Contra `origin/deploy/prod` sin el cambio (solo los specs nuevos), 15 fallos, entre ellos:
```
FAIL account.spec › cross-account guard › rejects an id namespaced to another account, personal included
FAIL message-ingestion.service.spec › an id namespaced to another account › conversationId / senderWaId / waMessageId
FAIL search.service.namespaces.spec › inEveryNamespace: an id already namespaced is looked up as given
FAIL server.account-guard.spec › refuses a leila id asked under professional | personal | undefined
Tests: 15 failed, 37 passed, 52 total
```
Con el cambio:
```
pnpm --filter ./mcp-server test -- account        → 5 suites, 53 tests passed (C1)
pnpm --filter @mcp-socialmedia/server test --runInBand → 55 passed, 1 skipped; 667 passed, 8 skipped (los skipped ya lo eran; repetido tras rebasar sobre `cb1fe60`, junto con build, tsc --noEmit y contract:check, todos exit 0)
pnpm -r --workspace-concurrency=1 test            → exit 0 (shared, workers, 4 conectores, mcp-server)
pnpm --filter @mcp-socialmedia/server build (tsc) → exit 0
pnpm --filter @mcp-socialmedia/server lint        → 0 errores (1240 avisos; no se midió la línea base)
pnpm contract:check                               → OK sha256:e30a4521…c0993d (73 tools)
```
Nota: `pnpm -r test` en paralelo falló una vez `connectors/whatsapp-web publisher.retention.test.ts` (0 !== 2, temporizador bajo carga; no toca este cambio); solo y en serie pasa (538 tests, 0 fallos).

## Tabla de llamadores (C8)

`rg "accountKey\(" mcp-server/src --glob '!*.spec.ts'` da 21 llamadas (sin la definición); la spec listaba 14, faltaban `embedding-job.ts:111` y `server.ts:1731, 3565, 4864, 4937, 5628, 5659`.

| Llamada | Origen del id | Conducta nueva | Test |
|---|---|---|---|
| `message-ingestion.service.ts:31-33` | `conversationId`, `senderWaId`, `waMessageId` del evento NATS `MessageReceived` que publica el conector de la cuenta | id de otra cuenta: lanza antes de escribir, `handleMessageReceived` lo registra (`Error ingesting message`) y relanza. Cuenta deshabilitada: `normalizeAccount` la rechaza antes, como hoy | `message-ingestion.service.spec.ts` |
| `embedding-job.ts:111` (`messageKeyFor`) | `waMessageId` o `tg_<chat>_<msg>` del evento NATS | lanza; `onMessage` lo captura y lo registra (`Error handling embedding job event`), el mensaje no se embebe | `embedding-job.spec.ts` |
| `repository.ts:369-370` (`getMessagesByUser`) | `waUserId` y `conversationId` de `handleGetUserMessages`, que hoy ninguna tool llama (`rg` solo halla su definición) | ajeno: lanza | `server.account-guard.spec.ts` |
| `repository.ts:401` (`getUserInfo`) | `waUserId` de ese mismo handler | ajeno: lanza | `server.account-guard.spec.ts` |
| `server.ts:628, 703, 1731` | `bareWhatsAppJid(target)` = `stripAccount(…).id`, siempre pelado | no puede lanzar | no hace falta: la entrada llega sin prefijo |
| `server.ts:3565` (`handleWhatsAppGetMessages`) | `chatId` de la tool | prefijado a otra cuenta: lanza (antes lectura vacía, o la conversación de la otra cuenta bajo `personal`) | `server.account-guard.spec.ts` |
| `server.ts:4864` | `tg_` + dígitos (regex `^-?\d+$`) | no puede lanzar | no hace falta |
| `server.ts:4937` | `bareTelegramTgId` = `stripAccount(…).id` | no puede lanzar | no hace falta |
| `server.ts:5628, 5659` | `stripAccount(…).id` del payload de no leídos | no puede lanzar | no hace falta |
| `search.service.ts:201, 227` | `chatId`/`sender` de la tool con `options.account` | ajeno: lanza (antes búsqueda vacía) | `search.service.namespaces.spec.ts` |
| `search.service.ts:367` (`brainScopes`) | `chatId` de la tool | **cambiado** (ver Desvío) | `search.service.namespaces.spec.ts` |
| `search.service.ts:477, 484` (`messagesById`) | igual que 201/227 | igual; con cuenta ajena ya falló antes en `brainScopes` | cubierto por los de 201/227 y 367 |
| `search.service.ts:613` (`inEveryNamespace`) | `chatId`/`sender` de la tool sin cuenta | **cambiado**: prefijado se busca tal cual, nunca se ensancha | `search.service.namespaces.spec.ts` |

Ningún llamador legítimo lanza ya: los ids que llegan de proveedor y los que pasan por `bareWhatsAppJid`/`stripAccount` son pelados. Los que lanzan son los de tool con un id de otra cuenta, lo que el guard pretende.

## Reutilizado

- `mcp-server/src/domain/account.ts` (`accountKey`, `stripAccount`), `account-registry.ts` (`AccountRegistryError`, `accountNamespaces()`), `domain/test-accounts.ts` (`useTestAccounts`) y el patrón `Object.create(MCPServer.prototype)` de los specs de `server.*`; los patrones de pool simulado de `instagram-ingestion.service.spec.ts` y de fetch simulado de `search.service.brain.spec.ts`.
- Buscado: `rg -n "accountKey\(" mcp-server/src`, `rg -n "Cross-account identifier|namespaceAccountId"` (0 fuera de `account.ts`: C5), `rg -n "AccountRegistryError" mcp-server/src --glob '!*.spec.ts'`, `gh pr list` por PRs que toquen `search.service.ts` (ninguna), `company-duplicados` (0 clones en los ficheros de este PR; los 85 que lista son de otros ficheros).
- Nuevo y por qué: el `throw` de tres líneas en `accountKey` (la regla vive solo ahí); el `if` de `inEveryNamespace` y el `continue` de `brainScopes` (el recorrido sin cuenta); cuatro specs porque ningún spec de prod ejercía `message-ingestion`, `inEveryNamespace`/`brainScopes` ni los llamadores de tool con ids prefijados.

## Checklist de la spec

- [x] C1. `accountKey('professional','leila:123')` y `accountKey('personal','leila:123')` lanzan; idempotente, bare y `professional:123` como antes. `pnpm --filter ./mcp-server test -- account` verde.
- [x] C2. Cuadro «falla / ya pasa» arriba: ningún test del fork es ejecutable en prod tal cual; el hunk de `account.spec.ts` y la idea del caso 1 de la integración, adoptados.
- [x] C3. Ingestión WhatsApp por cuenta (personal, professional, leila), cuenta deshabilitada (rechazada por `normalizeAccount` como hoy), id ajeno (rechazado, error registrado, nada escrito); Instagram no pasa por `accountKey` y una cuenta Instagram deshabilitada sigue rechazada; Telegram por `messageKeyFor`.
- [x] C4. `server.search-messages.spec.ts` sin cambios y verde; casos de `inEveryNamespace` con id prefijada y con cuenta deshabilitada.
- [x] C5. `rg "Cross-account identifier|namespaceAccountId"` solo encuentra `account.ts` (y los specs); `ARCHITECTURE.md` §4 lista los dos espejos sin guard con el motivo.
- [x] C6. `pnpm contract:check` verde, 73 tools, digest `sha256:e30a4521…c0993d` sin cambio.
- [x] C7. `pnpm -r test` verde (en serie), `pnpm-lock.yaml` sin cambios, `Co-authored-by: jibanez-staticduo <staticduo@gmail.com>` en `5bba8ed`, rutas de origen citadas.
- [x] C8. Tabla de llamadores arriba.

## Cómo se verifica

En copia limpia de la rama: `pnpm install --frozen-lockfile`, `pnpm contract:check`, `pnpm --filter @mcp-socialmedia/server test --runInBand`, `pnpm --filter ./mcp-server test -- account`. Tras el release de `mcp-server`: `social_list_accounts` y una lectura por cuenta; ningún `Cross-account identifier` en el log de ingestión de 1 h salvo que se analice (puede ser un bug latente de ids mal asignadas).

## Riesgos y notas

- Un cliente que pase un id prefijado de otra cuenta (o prefijado sin `accountId`) a una tool recibe el error en vez de un resultado vacío; la ingestión de un evento con id ajeno se pierde y queda en el log.
- Rebase sobre `origin/deploy/prod@cb1fe60` (#228, SKIRM-110) hecho, que incluye también `5675ea0` (INFRA-637). Único conflicto: la fila de `accountKey` de `ARCHITECTURE.md` §4, resuelta con el texto de este PR (única con guard + dos espejos sin guard); «Última verificación» y el resto del fichero son los del tronco (`git diff origin/deploy/prod -- ARCHITECTURE.md` solo toca esa fila). El `push --force-with-lease` sobre la rama remota quedó denegado dos veces; la rama rebasada se publica como `SKIRM-107-guard-cuentas-r2` y el coordinador cambia la cabeza de la PR #230. La rama antigua `SKIRM-107-guard-cuentas` (head `4a2bba1`, sobre `ca667c6`) queda obsoleta.
- Documento que refleja el cambio: `ARCHITECTURE.md` §4 y `.company/changes/skirm-107-guard-cuentas.md`.
