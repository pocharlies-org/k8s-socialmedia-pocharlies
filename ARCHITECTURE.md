# ARCHITECTURE.md — k8s-socialmedia-pocharlies

> `mcp-socialmedia` (el repo GitHub histórico se llama `whatsappmcp`): conectores de WhatsApp, Telegram e Instagram, servidor MCP y
> manifiestos. Guarda mensajes en Postgres+pgvector, caché Redis, ficheros MinIO, eventos NATS. **Monorepo código + k8s.**
> Escrito por `architect` (SC-1426).

## 1. Clientes y versiones

| cliente | repositorio / ruta | versión desplegada | cómo se despliega |
|---|---|---|---|
| `whatsapp-connector` (Baileys, :3001), `telegram-connector` (gramjs, :3002), `telegram-sync` (telethon, :3080), `instagram-connector` (:3003), `whatsapp-cloud-connector` (:3004) | `connectors/*` | imágenes por `tag@digest` (p. ej. instagram `sha-985a199ea567@sha256:38c14176…`; pool `v1.3.57`) | ArgoCD app `socialmedia` |
| `mcp-server` (:3000) y `mcp-sse` (:3010), superficie en `contracts/socialmedia-tools.json` | `mcp-server/src` | digest del `mcp-server`, compartido con los CronJobs de digest | ídem |
| Puente Synapse | `connectors/whatsapp-synapse-bridge` | digest | ídem |
| API de emparejamientos por sub: `social-api` (:3020, imagen `mcp-server`), `whatsapp-pairing` (:3001, imagen del conector, `src/pairing/main.ts`), `telegram-pairing` (:3002) | `k8s/base/social-pairing.yaml` | `social-api`: el `images:` del overlay prod (el pin de `mcp-server`); `whatsapp-pairing` y `telegram-pairing`: sus propias secciones de `k8s/overlays/prod/patch-image.yaml`, que no siguen a los conectores de la casa | ídem |
| `dgx-messages` (consola, ns `messages`) | fuera de este repo | su propia imagen | cliente de `social-api` (`SOCIAL_API_ALLOWED_AZP=dgx-messages`, `networkpolicy-social-pairing.yaml`); lee los adjuntos de `socialmedia-media` (:9000, `networkpolicy.yaml`) |

Los clientes de producto (Hermes, Claude, Synapse) consumen el MCP vía AgentGateway `/social`; un cambio de herramienta toca el catálogo
`contracts/socialmedia-tools.json` y el gateway.

## 2. Dependencias, en ambos sentidos

- **Depende de** — Postgres compartido + pgvector, Redis/Valkey, MinIO, NATS (`whatsapp-mcp-nats.whatsapp-mcp`), LiteLLM, Meta Graph/Cloud
  API, Baileys parcheado (`patches/@whiskeysockets__baileys@7.0.0-rc13.patch`), Harbor, 1Password/ExternalSecrets.
- **Búsqueda semántica → `skirmshop-brain`** (API `POST /instances/{instancia}/search`, `BRAIN_SEARCH_URL`; clave con alcance
  `BRAIN_MESSAGING_SEARCH_KEY`, Secret `whatsapp-mcp-brain-search` (item 1Password `brain-messaging-search`) montado solo en `mcp-sse`, INFRA-637:
  el brain exige `filters.account`). Hacia el otro lado, el brain depende de
  `brain-windows` (este repo) para su contenido.
- **Dependen de él** — AgentGateway `/social` (`social_*`), Synapse (eventos `whatsapp.MessageReceived`), Hermes, `auto-reply-worker`
  (tombstone), skirmshop-chatbot. **`CONTRACTS.yaml` con 93 entradas** (`http.whatsapp-connector.*`, `http.telegram-pairing.*`, subjects NATS…,
  más `contracts/socialmedia-tools.json`): nunca renombrar, solo `.vN+1` + `Contract-Change:`.
- **ArgoCD** `socialmedia`: repo `pocharlies-org/k8s-socialmedia-pocharlies`, path `k8s/overlays/prod`, tronco **`deploy/prod`**
  (`origin/deploy/prod` = 5675ea0), sync automático `prune: false`.

## 3. Stack

| pieza | versión | para qué | no se usa en su lugar |
|---|---|---|---|
| Node + pnpm workspace (`pnpm-workspace.yaml`, `connectors/tsconfig.json`) | lockfile | conectores TS, MCP | npm |
| Jest | `mcp-server/jest.config.js` | tests | — |
| Python (telethon) | `connectors/telegram-sync` | ingesta Telegram | — |
| `scripts/render-connectors.py` | PyYAML 6.0.2 | **genera** `generated/connectors.yaml` desde una fuente única | editar el generado a mano |
| Kustomize base + overlays | — | render | Helm |
| Búsqueda semántica de mensajes | brain (`/instances/{instancia}/search`) | la lectura **ya no usa pgvector ni embeddings de LiteLLM**; sin clave o con el brain caído contesta Postgres full-text y lo dice (`fallbackReason`); el escritor (`EmbeddingJob` → `message_embeddings`, pgvector) sigue activo y queda como deuda: retirarlo es otro cambio, con el cierre de INFRA-486 | embeber el query en este repo |

## 4. Componentes compartidos

| concepto | pieza canónica | ruta | quién la usa |
|---|---|---|---|
| Manifiestos de conectores | `scripts/render-connectors.py` (+ `--check` en CI) | `scripts/` | `k8s/` |
| Catálogo de tools | `contracts/socialmedia-tools.json` / `.md` | `contracts/` | gateway, Hermes |
| Registro de contratos | `CONTRACTS.yaml` | raíz | todos |
| Doc de la API social | `docs/social-api.md`, ADRs en `docs/adr` | `docs/` | operadores |
| ¿Es un primer contacto 1:1? (evidencia de contacto conocido) | `BaileysClient.knownDirectContactEvidence` + `chat-state.ts` `hasInboundHistory` / `hasOutboundHistory` | `connectors/whatsapp-web/src/` | todas las rutas de envío 1:1, vía `guardDirectSend` |
| Búsqueda semántica de mensajes | `mcp-server/src/application/search.service.ts` `SearchService.semanticSearch` | `mcp-server/src/application/` | `MCPServer.handleSearchMessages`; una instancia caída sale como `meta.partialErrors` (`completeness: 'partial'`), no tumba las demás |
| Clave opaca por cuenta (`personal` sin prefijo, el resto namespaceadas — migración 002) | `mcp-server/src/domain/account.ts` (`accountKey` / `normalizeAccount`) | `mcp-server/src/domain/` | MCP y job de embeddings; hay **dos espejos** de la misma regla que no pueden importarla: `connectors/whatsapp-web/src/db-writer.ts` (`accountKey`, en TS, por donde deben pasar los escritores del conector) y `connectors/telegram-sync/sync/db.py` (en Python): cambiar una sin las otras deja filas bajo otro id y mensajes sin embedding |

## 5. Cómo se construye aquí

Los manifiestos de conectores se generan: cambiar la fuente y regenerar (el CI falla con `--check` si hay deriva). Pins por
`tag@digest`; un CronJob de digest viaja con el digest del `mcp-server` (anotación `contracts.e-dani.com/socialmedia-digest`). Backfill de
reconexión de WhatsApp acotado (`WA_RECONNECT_BACKFILL_*`, INFRA-112). `CLAUDE.md` de la raíz documenta convenciones adicionales.

## 6. Tests y validaciones

```sh
python3 scripts/render-connectors.py --check && python3 -m unittest scripts/test_render_connectors.py
pnpm -r test                                  # jest (mcp-server, conectores)
python -m pytest connectors/telegram-sync/tests   # 14 casos (edits 4, voice_unwrap 10)
```
Total de casos Jest: **pendiente de medir**.

## 7. CI/CD y despliegue

- `ci.yml` (`arc-k8s`): render-check del generado, tests de Node/Python (el job de `telegram-sync` levanta un PostgreSQL 16 efímero, `TELEGRAM_SYNC_TEST_DATABASE_URL`); `release.yml` (`workflow_dispatch`) →
  `reusable-release.yml@5cbfd9dd…`; `release-instagram.yml`, `release-telegram-albums.yml`, `promote-telegram-albums.yml`, `deploy-stg.yml`.
- Despliegue: build de imagen → PR que sube `tag@digest` en `k8s/overlays/prod` → merge a `deploy/prod` → ArgoCD. **Validación en producción**:
  `social_list_accounts`/`social_validate_account` vía `/social`, un mensaje de prueba, estado de sesión de WhatsApp. Synced ≠ funcionando.
  Pendiente de ejecutar.

## 8. Decisiones y trampas

- Nombres heredados: directorio `mcp-socialmedia`, repo `whatsappmcp`, imágenes `whatsappmcp-*`: no renombrar (rompe pins y contratos).
- Hosts `*.lan.e-dani.com` de los conectores de WhatsApp (`whatsapp`, `whatsapp-pro`, `whatsapp-leila`; IngressRoutes generadas por `render-connectors.py`): `/api/public` va a `connector-public-api-deny`; `/qr` **y el resto del host** (`/api/v1/*`, `/status`) van tras `sso-chain` (ns `keycloak`, SKIRM-110; antes solo `/qr`, y `GET /api/v1/auth/qr` de leila respondía 200 sin credencial en la LAN). Los clientes de máquina no usan esos hosts: llaman al Service interno (`<conector>.whatsapp-mcp.svc.cluster.local:3001`, con el HMAC); un cliente nuevo que apunte a un host `.lan` recibe la redirección a Keycloak.
- WhatsApp Web personal usa sesión persistente: perderla exige re-emparejar (`http.whatsapp-pairing…`).
- `auto-reply-worker` personal está deshabilitado (tombstone): las respuestas de WhatsApp Business las lleva Synapse.
- `leila` comparte la instancia `personal` del brain y se aísla por `filters.account` (cada fragmento y cada fila se ligan a la cuenta de su consulta). Una instancia por cuenta (decisión INFRA-487) espera al ingest de `leila` en su vault: INFRA-554 (y INFRA-602 para los 43 puntos `account=leila`). `BRAIN_MESSAGING_SEARCH_KEY` (INFRA-637) llega a `mcp-sse` por el ExternalSecret `whatsapp-mcp-brain-search` (item `brain-messaging-search`, el mismo que lee el brain: lo compara por igualdad), con `secretKeyRef` **sin `optional`**: `mcp-sse` es `Recreate` con `hostPort: 3010`, así que sin el Secret el pod no arranca y cae todo `/social`; el item se crea antes de fusionar. Con el brain caído o un valor distinto (401) la búsqueda cae a texto con `fallbackReason`. `mcp-server` no la monta: nadie lo llama (el gateway va a `mcp-sse:3010`). ArgoCD no evalúa la salud de un ExternalSecret aquí: la sync-wave `-1` del ES ordena su creación, no espera al Secret.
- Envío 1:1 sin tctoken (SKIRM-92): `outbound_history` cuenta cualquier OUTBOUND no fallido de la conversación canónica (enviado desde el móvil del dueño o por el conector tras el guard). Un envío que WhatsApp rechaza con 463 solo deja de contar si `setMessageStatus` (`'failed'`) llega después de que exista la fila; un ack muy temprano la deja contando.
- [DECISION: k8s-socialmedia-pocharlies: el componente canónico de búsqueda semántica de mensajes es mcp-server/src/application/search.service.ts]

Última verificación contra el código: 2026-10-08 · 5675ea0 (origin/deploy/prod)
