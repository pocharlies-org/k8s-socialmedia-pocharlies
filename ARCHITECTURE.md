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

Los clientes de producto (Hermes, Claude, Synapse) consumen el MCP vía AgentGateway `/social`; un cambio de herramienta toca el catálogo
`contracts/socialmedia-tools.json` y el gateway.

## 2. Dependencias, en ambos sentidos

- **Depende de** — Postgres compartido + pgvector, Redis/Valkey, MinIO, NATS (`whatsapp-mcp-nats.whatsapp-mcp`), LiteLLM, Meta Graph/Cloud
  API, Baileys parcheado (`patches/@whiskeysockets__baileys@7.0.0-rc13.patch`), Harbor, 1Password/ExternalSecrets.
- **Búsqueda semántica → `skirmshop-brain`** (API `POST /instances/{instancia}/search`, `BRAIN_SEARCH_URL`; clave con alcance
  `BRAIN_MESSAGING_SEARCH_KEY`, que sembrará INFRA-637: el brain exige `filters.account`). Hacia el otro lado, el brain depende de
  `brain-windows` (este repo) para su contenido.
- **Dependen de él** — AgentGateway `/social` (`social_*`), Synapse (eventos `whatsapp.MessageReceived`), Hermes, `auto-reply-worker`
  (tombstone), skirmshop-chatbot. **`CONTRACTS.yaml` con 67 entradas** (`http.whatsapp-connector.*`, `http.telegram-pairing.*`, subjects NATS…,
  más `contracts/socialmedia-tools.json`): nunca renombrar, solo `.vN+1` + `Contract-Change:`.
- **ArgoCD** `socialmedia`: repo `pocharlies-org/k8s-socialmedia-pocharlies`, path `k8s/overlays/prod`, tronco **`deploy/prod`**
  (`origin/deploy/prod` = 5a06f33), sync automático `prune: false`.

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
| Búsqueda semántica de mensajes | `mcp-server/src/application/search.service.ts` `SearchService.semanticSearch` | `mcp-server/src/application/` | `MCPServer.handleSearchMessages`; una instancia caída sale como `meta.partialErrors` (`completeness: 'partial'`), no tumba las demás |
| Clave opaca por cuenta (`personal` sin prefijo, el resto namespaceadas — migración 002) | `mcp-server/src/domain/account.ts` (`accountKey` / `normalizeAccount`) | `mcp-server/src/domain/` | MCP y job de embeddings; `connectors/telegram-sync/sync/db.py` es **espejo en Python** de la misma regla (no puede importar TS): cambiar una sin la otra deja mensajes sin embedding |

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

- `ci.yml` (`arc-k8s`): render-check del generado, tests de Node/Python; `release.yml` (`workflow_dispatch`) →
  `reusable-release.yml@5cbfd9dd…`; `release-instagram.yml`, `release-telegram-albums.yml`, `promote-telegram-albums.yml`, `deploy-stg.yml`.
- Despliegue: build de imagen → PR que sube `tag@digest` en `k8s/overlays/prod` → merge a `deploy/prod` → ArgoCD. **Validación en producción**:
  `social_list_accounts`/`social_validate_account` vía `/social`, un mensaje de prueba, estado de sesión de WhatsApp. Synced ≠ funcionando.
  Pendiente de ejecutar.

## 8. Decisiones y trampas

- Nombres heredados: directorio `mcp-socialmedia`, repo `whatsappmcp`, imágenes `whatsappmcp-*`: no renombrar (rompe pins y contratos).
- WhatsApp Web personal usa sesión persistente: perderla exige re-emparejar (`http.whatsapp-pairing…`).
- `auto-reply-worker` personal está deshabilitado (tombstone): las respuestas de WhatsApp Business las lleva Synapse.
- `leila` comparte la instancia `personal` del brain y se aísla por `filters.account` (cada fragmento y cada fila se ligan a la cuenta de su consulta). Una instancia por cuenta (decisión INFRA-487) espera al ingest de `leila` en su vault: INFRA-554 (y INFRA-602 para los 43 puntos `account=leila`). Sin `BRAIN_MESSAGING_SEARCH_KEY` (INFRA-637) la búsqueda semántica queda dormida y todo cae a texto.
- [DECISION: k8s-socialmedia-pocharlies: el componente canónico de búsqueda semántica de mensajes es mcp-server/src/application/search.service.ts]

Última verificación contra el código: 2026-10-07 · 7957cdb (origin/deploy/prod)
