# ARCHITECTURE.md — k8s-socialmedia-pocharlies

> `mcp-socialmedia` (el repo GitHub histórico se llama `whatsappmcp`): conectores de WhatsApp, Telegram e Instagram, servidor MCP y
> manifiestos. Guarda mensajes en Postgres+pgvector, caché Redis, ficheros MinIO, eventos NATS. **Monorepo código + k8s.**
> Escrito por `architect` (SC-1426).

## 1. Clientes y versiones

| cliente | repositorio / ruta | versión desplegada | cómo se despliega |
|---|---|---|---|
| `whatsapp-connector` (Baileys, :3001), `telegram-connector` (gramjs, :3002), `telegram-sync` (telethon, :3080), `instagram-connector` (:3003) | `connectors/*` | imágenes por `tag@digest` (p. ej. instagram `sha-985a199ea567@sha256:38c14176…`; pool `v1.3.57`) | ArgoCD app `socialmedia` |
| `mcp-server` (:3000) y `mcp-sse` (:3010), superficie en `contracts/socialmedia-tools.json` | `mcp-server/src` | digest del `mcp-server`, compartido con los CronJobs de digest | ídem |
| Puente Synapse | `connectors/whatsapp-synapse-bridge` | digest | ídem |
| API de emparejamientos por sub: `social-api` (:3020, imagen `mcp-server`), `whatsapp-pairing` (:3001, imagen del conector, `src/pairing/main.ts`), `telegram-pairing` (:3002) | `k8s/base/social-pairing.yaml` | `social-api`: el `images:` del overlay prod (el pin de `mcp-server`); `whatsapp-pairing` y `telegram-pairing`: sus propias secciones de `k8s/overlays/prod/patch-image.yaml`, que no siguen a los conectores de la casa | ídem |
| `dgx-messages` (consola, ns `messages`) | fuera de este repo | su propia imagen | cliente de `social-api` (`SOCIAL_API_ALLOWED_AZP=dgx-messages`, `networkpolicy-social-pairing.yaml`); lee los adjuntos de `socialmedia-media` (:9000, `networkpolicy.yaml`) |

`whatsapp-cloud-connector` (:3004, `connectors/whatsapp-cloud`) no está desplegado: CI construye su imagen pero no hay manifiesto en `k8s/` (la Cloud API se
eliminó el 27-05, ver `CLAUDE.md`); su código sigue en el repo y usa `verifyMetaSignature` (§4).

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
  (tombstone), skirmshop-chatbot. **`CONTRACTS.yaml` con 101 entradas** (`grep -c '^  - id:' CONTRACTS.yaml`) (`http.whatsapp-connector.*`, `http.telegram-pairing.*`, subjects NATS…,
  más `contracts/socialmedia-tools.json`): nunca renombrar, solo `.vN+1` + `Contract-Change:`.
- **Quién llama a qué, y con qué firma.** La API de los conectores se firma con una sola clave, `CONNECTOR_SHARED_SECRET`: HMAC-SHA256 de
  `<ts>:<cuerpo JSON>` en `x-connector-timestamp` y `x-connector-signature`, ventana de 5 min. `mcp-sse` (código de `mcp-server`) firma
  sus llamadas al conector de WhatsApp, `providerGet` incluido (un GET no tiene cuerpo: firma `{}`); el conector exige la firma en
  `/api/public/*` (SKIRM-103), en `/api/v2/auth/qr` y en toda ruta de `/api/v1` salvo `/health`, `/manual-open/page` y `GET /auth/qr` (SKIRM-120: `src/api/v1-auth.test.ts` recorre
  la tabla de rutas de `controller.ts` y falla si una nueva queda sin `auth`). Sin firma y sin SSO a propósito: `/qr`, `/qr/page`, `/qr/renew`, `/status` (los hosts `.lan` los cubre `sso-chain`; dgx-infra
  sondea `/status`) y `GET /api/v1/auth/qr` (v1, deprecated hasta 2027-01-31). El conector de Telegram queda fuera de SKIRM-103 (SKIRM-111).
  El conector de Instagram exige la misma firma en **toda** ruta de `/api/v1` (SKIRM-112, `connectors/instagram/src/api-gate.ts`; `src/v1-auth.test.ts` recorre la tabla de rutas de `createInstagramApp`);
  quedan fuera `/health`, `/webhook` (firma de Meta, SKIRM-102) y `/oauth/instagram/callback`. `mcp-server` firma en `instagramCall` y el job `src/jobs/instagram-backfill.ts`; `x-user-sub` viaja
  junto a la firma y no la sustituye.
- **ArgoCD** `socialmedia`: repo `pocharlies-org/k8s-socialmedia-pocharlies`, path `k8s/overlays/prod`, tronco **`deploy/prod`**
  (`origin/deploy/prod` = 897435e), sync automático `prune: false`.

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
| Estado de un chat que informa el móvil o causa el dueño al leerlo (archivo, no leídos, fijado, silencio) | `setCanonicalChatState`: resuelve la conversación canónica una vez con `resolveCanonicalConversation` y escribe en ella archivo y no leídos (`setConversationState`) y fijado y silencio (`writeChatState`) | `connectors/whatsapp-web/src/chat-state.ts` | `chats.update`, `chats.upsert`, historia y `markAsRead` de `baileys-client.ts` |
| Canales de WhatsApp que sigue la cuenta (memoria de candidatos de `GET /channels`, no la respuesta) | `rememberedChannels` / `rememberChannel` / `forgetChannel` sobre `whatsapp_novedades_channels` (migración 021, PK `(account, channel_jid)`) | `connectors/whatsapp-web/src/channels.ts` | `BaileysClient.listChannels`, `lookupChannel`, `setChannelSubscription` (solo con `ingest`) |
| Búsqueda semántica de mensajes | `mcp-server/src/application/search.service.ts` `SearchService.semanticSearch` | `mcp-server/src/application/` | `MCPServer.handleSearchMessages`; una instancia caída sale como `meta.partialErrors` (`completeness: 'partial'`), no tumba las demás |
| Verificación de `x-hub-signature-256` (firma de los webhooks de Meta) | `verifyMetaSignature(rawBody, header, secrets)` | `shared/src/crypto/meta-signature.ts` | `instagram-connector` (`webhookSignatureGuard`), `whatsapp-cloud`; no es `verifyHMACSignature` (esquema `ts:cuerpo` de los conectores) |
| Puerta HMAC de un router de conector | `createHMACAuth(secret, onReject?)` y `createHMACRejectLog(etiqueta)` (una línea por motivo cada 10 s, sin cabeceras, cuerpo, firma ni query); el esquema compartido es `verifyHMACSignature` | `shared/src/crypto/connector-auth.ts` (`whatsapp-web/src/api/auth.ts` lo reexporta) | `/api/v1`, `/api/public` (`createPublicRouter`) y `/api/v2/auth/qr` de `whatsapp-web`; `/api/v1` de `instagram-connector` (`connectorApiGate`) |
| Clave HMAC de los conectores: ¿es utilizable? | `requireConnectorSecret(env?, warn?)`: ausente o vacía lanza (el proceso no arranca); el valor por defecto del repositorio registra un error, una vez por proceso, y sigue, salvo con `CONNECTOR_SECRET_STRICT=true`, que lo rechaza (SKIRM-103) | `shared/src/crypto/connector-secret.ts` | `whatsapp-web` (`main.ts`, `dashboard-notifier.ts`), `mcp-server` (`mcp/index.ts`, `mcp/sse-server.ts`, `jobs/instagram-backfill.ts`) e `instagram-connector` (`api-gate.ts`, que no tumba el proceso: ver §8); telegram, whatsapp-cloud y sus notifiers lo adoptan en SKIRM-111 |
| Clave opaca por cuenta (`personal` sin prefijo, el resto namespaceadas — migración 002) | `mcp-server/src/domain/account.ts` (`accountKey` / `normalizeAccount`) — **la única con guard**: `accountKey` lanza `Cross-account identifier` si el id ya está namespaced a otra cuenta (SKIRM-107); sin `normalizeAccount` dentro, porque la búsqueda sin cuenta (`inEveryNamespace`, `brainScopes`) recorre también cuentas deshabilitadas | `mcp-server/src/domain/` | MCP y job de embeddings. Dos **espejos sin guard** de la misma regla (no pueden importar TS): `connectors/whatsapp-web/src/db-writer.ts` `accountKey` y `connectors/telegram-sync/sync/db.py` `account_key`. No llevan el guard porque cada proceso escribe solo su cuenta (`CONNECTOR_ACCOUNT`) y los ids vienen del proveedor (un JID nativo no lleva estos prefijos); cambiar la regla en una sin las otras deja mensajes sin embedding |
| Recuperación de medios de Telegram (reintento con espera creciente, estado en `messages.metadata`) | `media_recovery.run` + `db.pending_media` / `db.media_transaction` / `db.media_result` | `connectors/telegram-sync/sync/` | `telegram-sync` (una tarea por cuenta, junto al consumidor NATS y la historia); pide el mensaje exacto a `GET /api/v1/messages/single/:chatId/:msgId` y los bytes a `.../messages/media/...` del conector |

## 5. Cómo se construye aquí

Los manifiestos de conectores se generan: cambiar la fuente y regenerar (el CI falla con `--check` si hay deriva). Pins por
`tag@digest`; un CronJob de digest viaja con el digest del `mcp-server` (anotación `contracts.e-dani.com/socialmedia-digest`). Backfill de
reconexión de WhatsApp acotado (`WA_RECONNECT_BACKFILL_*`, INFRA-112). `CLAUDE.md` de la raíz documenta convenciones adicionales.

## 6. Tests y validaciones

```sh
python3 scripts/render-connectors.py --check && python3 -m unittest scripts/test_render_connectors.py
pnpm -r test                                  # jest (mcp-server, conectores)
python -m pytest connectors/telegram-sync/tests   # 36 casos (edits 4, insert_message 2, media_backlog_postgres 6, media_recovery 14, voice_unwrap 10)
pnpm --filter ./connectors/telegram test          # 77 casos, node:test con lista explícita de ficheros en package.json
```
Los tests de telegram-sync con PostgreSQL (`test_edits`, `test_media_backlog_postgres`, la carrera de `test_media_recovery`) se saltan sin
`TELEGRAM_SYNC_TEST_DATABASE_URL`, y un «skipped» no es un pase. Los tests de los conectores TS no son jest ni `supertest`: `tsx --test` sobre una
lista explícita en `connectors/*/package.json` (un test nuevo que no se añade ahí no corre nunca en CI), y las pruebas HTTP arrancan la app y llaman con `fetch`.
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
- `leila` comparte la instancia `personal` del brain y se aísla por `filters.account` (cada fragmento y cada fila se ligan a la cuenta de su consulta). Una instancia por cuenta (decisión INFRA-487) espera al ingest de `leila` en su vault: INFRA-554 (y INFRA-602 para los 43 puntos `account=leila`). `BRAIN_MESSAGING_SEARCH_KEY` (INFRA-637) llega a `mcp-sse` por el ExternalSecret `whatsapp-mcp-brain-search` (item `brain-messaging-search`, el mismo que lee el brain: lo compara por igualdad), con `secretKeyRef` **sin `optional`**: `mcp-sse` es `Recreate` con `hostPort: 3010`, así que sin el Secret el pod no arranca y cae todo `/social`; el item se crea antes de fusionar. Con el brain caído o un valor distinto (401) la búsqueda cae a texto con `fallbackReason`. `mcp-sse` espera al brain `BRAIN_SEARCH_TIMEOUT_MS=30000` (INFRA-743; el código corta a 10 s por defecto y las lecturas frías de Qdrant tardan 2–50 s, INFRA-744); lo que hay delante lo admite (AgentGateway `/social` `requestTimeout: 120s`). `mcp-server` no la monta: nadie lo llama (el gateway va a `mcp-sse:3010`). ArgoCD no evalúa la salud de un ExternalSecret aquí: la sync-wave `-1` del ES ordena su creación, no espera al Secret.
- Envío 1:1 sin tctoken (SKIRM-92): `outbound_history` cuenta cualquier OUTBOUND no fallido de la conversación canónica (enviado desde el móvil del dueño o por el conector tras el guard). Un envío que WhatsApp rechaza con 463 solo deja de contar si `setMessageStatus` (`'failed'`) llega después de que exista la fila; un ack muy temprano la deja contando.
- Medios de Telegram (SKIRM-101): el estado de reintento vive en `messages.metadata` (`media_status` retry/stored/unavailable/deleted,
  `media_attempts`, `media_next_retry` en epoch), sin tabla ni columna. Cada fallo espera 30 s duplicando por intento hasta 3600 s, o el `Retry-After` de un
  429 si es mayor. La 8.ª falla contada (`MEDIA_RECOVERY_MAX_ATTEMPTS`, 8 por defecto) deja el mensaje `unavailable` y `pending_media` y los elegibles del
  atraso ya no lo eligen (siguen en `total_missing`); un 429 o un 503 del conector espera pero no cuenta. El recuperador corre cada `MEDIA_RECOVERY_INTERVAL_S` (60 s por defecto: sus dos consultas barren `messages` en `personal`, 0,3 a 0,8 s)
  y toma 5 mensajes por ciclo. Tiempo real e historia no cambian: solo el recuperador reintenta; comparten con él `db.media_transaction`
  (`SELECT … FOR UPDATE` del mensaje, que se mantiene durante la descarga y la subida a MinIO: `idle_in_transaction_session_timeout` debe ser 0 o
  mayor que `CONNECTOR_MEDIA_TIMEOUT`, 150 s). `attachments` de prod solo guarda la clave en `file_url` (no hay `storage_key`). El primer arranque lanza el
  atraso entero. El conector corta una descarga de medio a los 120 s y la foto de perfil a los 20 s (504), un `FLOOD_WAIT` sale como 429 y se conserva
  el `Proxy` de `telegramReadClient`: mtcute pasa `floodSleepThreshold: Infinity` explícito en sus descargas y `withParams()` deja ganar los parámetros explícitos.
  La lectura de historia (`getHistory`, `/messages/:chatId`) no pasa por ahí: sigue como antes.
- Webhook de Instagram (SKIRM-102, `http.instagram-connector.webhook.v1`): `POST /webhook` exige `x-hub-signature-256` (`sha256=` + 64 hex) sobre el cuerpo crudo (`express.json({ verify })` → `req.rawBody`), siempre y cerrado por defecto. Secretos aceptados, lista cerrada (`metaAppSecrets` en `connectors/instagram/src/main.ts`): `FACEBOOK_APP_SECRET`, `INSTAGRAM_LOGIN_APP_SECRET` (son dos apps de Meta y la firma no dice cuál firmó) y el `appSecret` de cada cuenta cargada, descartando los vacíos antes de comparar (una clave vacía firma cualquier cosa); nunca `INSTAGRAM_WEBHOOK_SECRET`, `INSTAGRAM_INTERNAL_API_TOKEN` ni `WEBHOOK_VERIFY_TOKEN`. Sin firma válida 401; sin ningún secreto 503; el 200 sale después de verificar y el cuerpo no se registra. `WEBHOOK_VERIFY_TOKEN` ya no tiene valor por defecto: sin él el GET de verificación responde 503. Meta desactiva una suscripción que falla muchas veces: tras un cambio de secretos se vigilan los rechazos (un `warn` por motivo cada 10 s, con contador).
- `/api/public/*` del conector de WhatsApp (SKIRM-103): `chats`, `history/:chatId` y `backfill-media` exigen la firma HMAC del conector
  (`createPublicRouter` en `connectors/whatsapp-web/src/api/public-routes.ts`; el borde las sigue negando con `connector-public-api-deny`). Un GET firma
  `{}` y `backfill-media` lleva sus parámetros en la query con el cuerpo vacío. **Firma a mano**: `ts=$(date +%s); sig=$(printf '%s:{}' "$ts" | openssl dgst -sha256 -hmac "$CONNECTOR_SHARED_SECRET" -hex | sed 's/^.* //')`
  y las cabeceras `x-connector-timestamp: $ts`, `x-connector-signature: sha256=$sig`. Es el esquema de `/api/v1`: la firma cubre `ts:cuerpo` (no liga método, ruta ni
  query y no hay caché de repetición) y el timestamp tiene que ser numérico y estar dentro de 5 minutos. Cada rechazo deja una línea
  `[public-api] rejected <método> <ruta> ip=… reason=…` (una por motivo cada 10 s; sin cabeceras, cuerpo, firma, query ni el chatId): así se ve en minutos un consumidor no enumerado.
  `/api/v2/auth/qr` es la carga de `GET /api/v1/auth/qr` con firma; la v1 sigue sin firma y deprecated hasta 2027-01-31.
- **Clave HMAC de los conectores (SKIRM-103).** `CONNECTOR_SHARED_SECRET` tiene que ser una clave propia. `requireConnectorSecret()` (`shared`) la comprueba al arrancar en
  `whatsapp-web` (`main.ts`, y en cada firma del `dashboard-notifier.ts`) y en `mcp-server` (`mcp/index.ts`, `mcp/sse-server.ts`; en el cluster solo `mcp-sse` pasa por ahí:
  el Deployment `mcp-server` es el ingestor y no firma). Ausente o vacía, el proceso no arranca. El valor por defecto del repositorio (`dev-secret-change-in-production`) registra un error,
  una vez por proceso, y arranca; con `CONNECTOR_SECRET_STRICT=true` en el Deployment, lo rechaza y el proceso no arranca. Así un pin de la imagen nunca depende del orden en que se cambia la
  clave, y el estricto se activa donde y cuando la clave propia ya está puesta.
  **Cómo se activa**: por Deployment, igual en `mcp-sse` y en los tres conectores de WhatsApp, en `k8s/overlays/prod` (parche del Deployment, junto al pin de su imagen en
  `patch-image.yaml`), **nunca en `base/`**: una variable nueva en la plantilla del pod reinicia los tres conectores fuera de la ventana (SKIRM-88). Orden: (1) la clave propia en el Secret,
  (2) comprobar por sha256, sin imprimirla, que ya no es el valor por defecto, (3) `mcp-sse`: pin de la imagen de `mcp-server` y el interruptor en el mismo commit, (4) un conector cada vez
  (leila, professional, personal) con su pin y su interruptor en el mismo commit, con `restartCount` estable y la sesión sin re-emparejar. El interruptor se retira cuando el estricto pase a
  ser el valor por defecto (SC-2149). Prueba de cierre: un GET firmado con el valor por defecto a `/api/public/chats` responde 401 en cada conector.
- **API del conector de Instagram (SKIRM-112).** Todo `/api/v1` (`/accounts`, `/oauth/instagram/authorize-url`, las rutas `/:account/*`; también un camino que ninguna ruta sirve) pasa por `createHMACAuth` con
  `CONNECTOR_SHARED_SECRET`: sin firma, con otra clave, con la firma de otro cuerpo o fuera de ventana, 401. Un GET firma `{}`. **Cierra sin tumbar el proceso**: el webhook (Meta reintenta y desactiva la suscripción)
  y `/health` (lo sondea el dashboard) tienen que seguir contestando aunque la API no pueda, así que con la clave ausente o vacía, o con el valor por defecto bajo `CONNECTOR_SECRET_STRICT=true`, cada petición
  a `/api/v1` es un 503 y el arranque deja un `warn`; con el valor por defecto sin el interruptor avisa y acepta (la firma con un valor público no protege). Cada rechazo deja una línea
  `[instagram-api] rejected <método> <ruta> ip=… reason=…` (una por motivo cada 10 s; la ruta llega hasta el nombre de la cuenta). El almacén de credenciales por usuario no cambia: la firma identifica al servicio
  que llama y `x-user-sub` sigue diciendo a quién sirve. **Orden**: (1) firman los consumidores (`mcp-server`: `mcp-sse`, los CronJobs de brain y el Job PreSync comparten su pin; un llamante nuevo firma
  como `mcp-server`), (2) después exige el conector; `CONNECTOR_SECRET_STRICT=true` se declara en el overlay con el pin de la imagen, como en WhatsApp, y no antes de que la clave propia esté puesta.
  Firma a mano: la misma receta de `openssl` de arriba, con `/api/v1/accounts` como ruta.
- Estado de chat de WhatsApp (SKIRM-104, SKIRM-105): `archived` y `unread_count` de `chats.update`, `chats.upsert`, la historia y `markAsRead` (`POST /messages/read/:chatId`) se escriben en la
  conversación canónica (`setCanonicalChatState`, que también escribe el fijado y el silencio del mismo evento con una sola resolución), nunca en un tombstone (`merged_into`), que ninguna lista muestra;
  sin conversación para el jid no se escribe nada. El helper no lanza: un fallo de la base queda en un `warn` (también en `markAsRead`, cuyos acuses de lectura ya salieron). El id lleva el prefijo de la cuenta del conector y la resolución filtra por `account_id`, así que una cuenta no escribe sobre la fila de otra. Al reconectar,
  `resyncChatState` pide los parches desde la versión guardada del app-state; no se lee el snapshot completo del app-state (más memoria y más consultas a WhatsApp, SKIRM-88).
  `POST /messages/pins` solo acepta un `conversationId` o `chatId` de tipo string.
- Respuesta a un evento y votos de encuesta (SKIRM-105): la respuesta a un evento se firma con teléfonos, que es como Baileys la descifra. Nuestro número sale de `sock.user`, de `meJid` o, si solo se conoce el LID, de la correspondencia LID a número de Baileys (`ownIdentity` + `withAliases`); sin número propio o sin el del creador, 422 `identity_unavailable` antes de reclamar la `Idempotency-Key` y antes de retransmitir. Los votos y respuestas entrantes se guardan por el remitente de la clave (`participant` o `remoteJid`); que un mismo votante por número y por LID cuente una vez lo pliega la base (013: disparador y vistas `*_current`) y solo cuando `social_contact_aliases` conoce el par.
- Canales de WhatsApp que sigue la cuenta (SKIRM-106, migración 021): Baileys rc13 no puede preguntar a WhatsApp qué canales sigue una cuenta, así que `GET /channels` (`social_list_channels`) parte de candidatos y confirma cada uno con su metadata. `whatsapp_novedades_channels` es la memoria de esos candidatos (una fila `(account, channel_jid)` por canal que el conector vio seguir: la escribe `lookupChannel` o `setChannelSubscription` al confirmarlo y la borra la confirmación contraria, solo con `ingest`); no es la respuesta: cada fila se vuelve a confirmar en cada listado, así que una fila vieja nunca lista un canal que no se sigue. Sin tabla (021 sin aplicar) el conector avisa una vez, no recuerda nada y vuelve a preguntar cada pocos minutos, sin reiniciar: el orden conector / migración no importa. No hay backfill: un canal seguido antes de la 021 se recuerda la próxima vez que se consulte o se siga.
- Identidad de un post de canal de WhatsApp (SKIRM-106): el id de un mensaje de `<id>@newsletter` solo es único dentro de su canal, y `messages.wa_message_id` es una clave por cuenta con `ON CONFLICT DO NOTHING`. `channelPostMessageId` (`connectors/whatsapp-web/src/statuses.ts`) deja el id tal cual salvo que otro canal ya lo tenga: entonces el post se guarda, con su `whatsapp_message_keys`, bajo `<jid del canal>:<id>` (sin migración y sin tocar filas existentes). El ingest y el revoke o la edición que nombran el post usan la misma función, así que llegan a la fila de SU canal; `social_list_channel_posts` devuelve ese `messageId` compuesto. `whatsapp_message_payloads` guarda una copia por id y su `key.id` es el de WhatsApp, así que el payload de un post guardado con id compuesto no se escribe (el del primer canal queda intacto).
- Un borrado que llega antes de su post (SKIRM-106): para un post de canal o un estado, `handleInboundMutation` anota en memoria (`noteRevokeBeforePost` en `statuses.ts`) el revoke que no encontró fila, con clave `<chat>|<id de WhatsApp>` tal como llega (antes de componer el id y sin prefijo de cuenta, así ni el orden de llegada ni el id compuesto dan la tumba a otro canal), y `ingestMessage` la consume (`takeRevokeBeforePost`) justo después de guardar el post y lo marca borrado como cualquier revoke (el contenido se queda y sale `message-update DELETED`). Como mucho 2000 anotaciones (sale la más antigua) y 24 h de vida. **Límite**: no sobrevive a un reinicio y cubre la carrera dentro de un proceso (lote de reconexión, historia); una tumba durable sería una migración 022 aparte. Dos líneas `info` para medirla: «found no post: remembered» y «arrived before its post: applied».
- [DECISION: k8s-socialmedia-pocharlies: el componente canónico de búsqueda semántica de mensajes es mcp-server/src/application/search.service.ts]

Última verificación contra el código: 2026-10-10 · fc402ef (origin/deploy/prod)
