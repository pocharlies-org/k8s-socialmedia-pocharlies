# whatsappmcp — Notas para Claude

## Qué es

Servidor MCP multi-plataforma (WhatsApp + Telegram + Instagram) que expone tools a Claude/LLMs por SSE. Almacena mensajes en Postgres+pgvector, usa Redis (cache), MinIO (ficheros) y NATS (event bus). LLM vía LiteLLM.

## Dónde corre

- **Producción actual: k8s namespace `whatsapp-mcp`** (sauvage / ubuntu node)
- ArgoCD app: `socialmedia` → repo `pocharlies/k8s-socialmedia-pocharlies`, branch `deploy/prod`, path `k8s/overlays/prod`
- Promoción: workflow_dispatch en `.github/workflows/release.yml` o tag push
- El stack docker-compose viejo en sauvage `~/mcp-socialmedia/` está parado a propósito desde 2026-05-22 (migración a k8s). NO arrancarlo.
- Imágenes en Harbor: `harbor.e-dani.com/homelab/whatsappmcp-*`

## Multi-account (personal / professional / leila)

El MCP enruta cada call a una de tres cuentas de WhatsApp (y dos de Telegram):

| Account | Telegram | WhatsApp |
|---|---|---|
| `personal` (**default**) | `telegram-connector` — sesión `paxanguero` | `whatsapp-connector` — Baileys (número personal) |
| `professional` | `telegram-connector-professional` — sesión `sauvageadminbot` (skirmshop) | `whatsapp-connector-professional` — Baileys (número de negocio) |
| `leila` | — (sin conector Telegram; `accountId: 'leila'` + `channel: 'telegram'` = "not configured") | `whatsapp-connector-leila` — Baileys (número de Leila), **desplegada pero SIN emparejar** |

- **Las tres cuentas de WhatsApp son Baileys (WhatsApp Web)** — cada una un Deployment con su número, sesión y PVC propia. NO se usa Cloud API (eliminado: el usuario no quiere pagar a Meta y quiere contestar a mano desde el móvil; Baileys es un dispositivo vinculado).
- Para indicarle al MCP qué cuenta usar pasa `accountId: 'personal' | 'professional' | 'leila'` en la tool call (el parámetro canónico se llama `accountId`; el `account` interno de los handlers se deriva de él).
- Default global: `personal`. Si el chat es claramente de skirmshop/business → pasar `professional`.
- Para agentes/sesiones de Claude/Codex/OpenClaw que NO sean específicamente "hogar"/"familia", la guía es: **siempre `account: 'professional'`** salvo que el chat destino sea familiar/personal.
- Vincular el número professional: escanear el QR en `https://whatsapp-pro.e-dani.com/qr/page`.
- Vincular el número de Leila (pendiente del operador — SC-1144 criterio 2): QR **solo por LAN** en `https://whatsapp-leila.lan.e-dani.com/qr/page` (botón de renovar activo vía `ALLOW_WEB_RENEW`, igual que professional). NUNCA exponerla al edge: la página pública del personal (`whatsapp.e-dani.com`) es legado y no se replica.

DB scoping (migración 002): los ids de la cuenta `personal` no llevan prefijo (compat con ~449k filas existentes); los de `professional` van prefijados `professional:` y los de `leila` `leila:`. La columna `account` está indexada para filtros rápidos.

### Payloads duraderos de WhatsApp (fase 3 / PR-1, migración 009)

El conector guarda el WAMessage crudo (key + contenido, BufferJSON, sin miniaturas ni material de claves) en `whatsapp_message_payloads` con los mismos ids namespaced que `messages` (`connectors/whatsapp-web/src/durable-message-store.ts`). Lo usan: citar al responder, `/api/v1/messages/forward` (reenvío real `{ forward }`, 404 `message_unavailable` si no hay original) y el `getMessage` de reintentos de Baileys — memoria primero, luego la copia duradera. Se guarda tráfico vivo y envíos propios; history-sync solo si es más reciente que `DURABLE_PAYLOAD_HISTORY_DAYS` (7 por defecto, 0 = nunca); tope `DURABLE_PAYLOAD_MAX_BYTES` (256 KiB). Sin la tabla (009 sin aplicar) falla en blando: un log y comportamiento en memoria, re-sondea cada 5 min. La pool de emparejamiento (`ingest: false`) nunca la toca. Sin retención todavía.

### Vínculos de identidad por usuario (SC-1144 fase 2, bandera OFF)

Un usuario verificado solo puede tocar las cuentas ligadas a su `sub` de Keycloak. La tabla vive en GitOps: `k8s/base/social-identity-bindings.yaml` (misma forma y misma postura fail-closed que `backends/workspace/identity-bindings.yaml` de k8s-agentgateway-pocharlies), montada en el pod `mcp-sse` como ConfigMap de nombre estático en `/identity/` — el código (`mcp-server/src/domain/identity-bindings.ts`) **relee el fichero cuando cambia (stat mtime+size), así editar un vínculo no reinicia el pod**.

- Bandera `SOCIAL_IDENTITY_BINDING` (default **`off`**; el repo la entrega off en base y en prod). Con OFF: cero lecturas del fichero, enrutado byte-idéntico al de siempre. Volcarla a ON es decisión del operador.
- Con ON, el gate único es `applyIdentityBinding` en `executeCanonicalTool` (todas las tools con `accountId` pasan por ahí; `social_list_accounts` no lo tiene y no se gatea):
  - `sub` ligado + `accountId` pedido fuera de su lista → error explícito nombrando principal y cuentas ligadas.
  - `accountId` omitido → **primera cuenta de su lista** (nunca el default global `personal`).
  - `sub` sin entrada en la tabla, o llamada sin `x-user-sub` → fail-closed, ninguna cuenta.
- El vínculo es **por cuenta, sea el canal que sea**: con ON, Instagram (`skirmshop`/`barbelpapis`) queda fail-closed para todo el mundo hasta que se añadan a la tabla.
- **Riesgo residual declarado**: `x-user-sub` lo estampa el gateway sobrescribiendo al cliente, pero `mcp-sse` es alcanzable por la ruta LAN `mcp-socialmedia.lan.e-dani.com` con el **bearer compartido**, así que quien posea ese token puede forjar la cabecera. Eso lo cierra la **Parte 5 (SC-1146, retirada de la clave compartida)**, no esta historia.

## Almacén de credenciales por usuario (SC-552 + fase 1.5 SC-705)

Decisión CTO 13-09-2026: UN almacén por `sub` del JWT que el AgentGateway verifica en `/social` y reenvía como cabecera `x-user-sub`, con tres adaptadores de canal — no tres almacenes paralelos. Implementación en `shared/src/session-store/` (desde la fase 1.5, 21-09: la consumen DOS runtimes — mcp-server y el conector whatsapp-web —; un solo código que habla con la tabla). Sus specs de regresión corren en el jest de mcp-server (`mcp-server/src/infrastructure/session-store/*.spec.ts`, que compila `shared` antes de testear).

- `credential-store.ts` — tabla `user_channel_credentials` (migración 007, PK `(session_key, channel)`). Persistencia = la DB `whatsappmcp`: sobrevive reinicios del gateway y de los pods. **El payload va CIFRADO en la capa del store** (`put` cifra, `get` descifra; la DB nunca ve texto plano): envelope AES-256-GCM con data-key aleatoria por fila envuelta por la clave maestra `CREDENTIAL_STORE_MASTER_KEY` (base64 de 32 bytes; viaja dentro del item 1Password `whatsapp-mcp` → `envFrom`; formato y justificación del envelope en `payload-crypto.ts`). Fail-closed: sin clave, `put`/`get` lanzan; una fila NO-envelope se rechaza.
- `request-context.ts` — AsyncLocalStorage alrededor de `transport.handleRequest`/`handlePostMessage` en `sse-server.ts` (por POST); expone `x-user-sub`/`x-user-name` al contexto de la tool call. Sin cabecera → contexto vacío. `actorRequestHeaders()` reenvía el actor en las llamadas HTTP del mcp-server a los conectores (SC-705).
- `adapters/` — baileys (directorio multi-file auth-state → `{files: nombre→base64}`), mtcute (session string), instagram (token Graph + ids). Cada canal conserva su formato; el store no lo interpreta.
- `credential-resolver.ts` — `resolveCredential`: (1) cabecera + fila → la fila gana; (2) sin cabecera → ruta legacy exacta, cero lecturas/escrituras; (3) cabecera sin fila → adopt-on-first-use (leer legacy, escribir fila, servir legacy).

**Cableado WhatsApp (fase 1.5, `connectors/whatsapp-web/src/credential-session.ts`)**: un conector por sesión emparejada indexa su sesión por `session_key = <sub>` (o `<sub>:<cuenta>` si un usuario tuviera dos cuentas — convención del tech-lead, el PK ya la soporta). Con `CREDENTIAL_STORE_ENABLED=true` **y** `CREDENTIAL_SESSION_KEY=<sub>`: authDir por sub (`<SESSION_PATH>/by-sub/<key>/baileys-auth`), carga de la fila antes de `connect()` (persistencia tras `rollout restart`, sin QR), write-back OBLIGATORIO de `saveCreds`→`store.put` (debounced, con trailing run) y borrado de la fila en `loggedOut`. Sin `CREDENTIAL_SESSION_KEY` (las cuentas de la casa `personal`/`professional`) o con flag OFF: ruta legacy exacta, cero lecturas/escrituras — criterio de cero regresión.

Despliegue: la migración 007 NO se aplica todavía — el Job PreSync `whatsapp-mcp-migrate` queda fuera del PR 52 (veredicto architect SC-1144: las imágenes pinneadas son pre-almacén y un PreSync que falla bloquea el sync de toda la app) y se re-añade en el PR2 junto al re-pin de imagen; `migrate.ts` ya lleva ledger `_migrations` (salta lo aplicado, baseline de esquemas previos al ledger, transacción por fichero). `CREDENTIAL_STORE_ENABLED=false` en este PR; el `true` SOLO en el overlay `prod` llega con el PR2 (`k8s/overlays/.../patch-credential-store.yaml`; stg OFF). Pendiente de fase 2: pool multiplexado por `sub` en un solo proceso; inyección de `x-user-sub` en la ruta `/social` del AgentGateway (hoy solo la hacen `/workspace` y `/chat-*` vía `transformations.request.set`).

El mismo `request-context.ts` es la base de los **vínculos de identidad SC-1144 fase 2** (sección "Vínculos de identidad por usuario" arriba): `getRequestActor().sub` alimenta `mcp-server/src/domain/identity-bindings.ts`, gated por `SOCIAL_IDENTITY_BINDING` (default OFF, misma regla de no-regresión: sin cabecera y sin bandera, ruta legacy exacta).

## API de emparejamientos por sub (SC-1197) — topología nueva

Tres Deployment: **`social-api`** (:3020, imagen mcp-server) es la ÚNICA cara y el ÚNICO proceso del repo que verifica el JWT de Keycloak (RS256 via jose, iss `https://auth-next.e-dani.com/realms/edani`, `aud` CONTIENE `social-api`, `azp` ∈ `dgx-messages`, `typ` NO se comprueba — medido 25-09, Keycloak 26.6.2 emite `typ: JWT`); **`whatsapp-pairing`** (:3001, pool baileys por sub) y **`telegram-pairing`** (:3002, pool mtcute por sub) son pools INERTES: nunca ven un JWT, solo a social-api por el HMAC interno de siempre (`CONNECTOR_SHARED_SECRET`, cabeceras `x-connector-*`) y el `sessionKey = sub` viaja DENTRO del cuerpo firmado (todo POST; `/internal/{whatsapp,telegram}/sessions/...`). Persistencia SOLO en el credential store (las pools: emptyDir de memoria, sin PVC, `Recreate`). Rutas: `POST /pairing/{whatsapp,telegram}/start`, `GET /pairing/{whatsapp,telegram}` (QR por POLLING, no SSE), `POST /pairing/telegram/password` (2FA), `GET /me/{whatsapp,telegram}`, `GET /social/status` (siempre 200; estados `paired|expired|unpaired|unavailable`) y `GET /health` sin auth. `x-user-sub` NO es entrada de auth aquí (a diferencia del enrutado MCP). Topes: 10 sesiones concurrentes por pool; por sub 1 start/60 s, 10/día, 5 QR por start. Es el "pool multiplexado por sub" que quedaba pendiente en la fase 2 del almacén.

Flags (todas entregadas INERTES por `k8s/base/social-pairing.yaml`, P3: `replicas: 0`): `SOCIAL_PAIRING_API` (`on` = trim/lowercase; off → 404 salvo /health, en las tres caras), `CREDENTIAL_STORE_ENABLED` (`true` + `CREDENTIAL_STORE_MASTER_KEY` válida, si no 503 `pairing_unavailable`), `SOCIAL_API_ALLOWED_ORIGINS` (vacío por defecto: un `Origin` presente fuera de la lista es 403; nunca se contestan cabeceras CORS) y `SOCIAL_IDENTITY_BINDING` (NO la lee social-api: gatea las tools del MCP; `/social/status` lee los vínculos siempre, fail-closed). El resto del env es el contrato con los manifests P3 (`WHATSAPP_PAIRING_URL`, `TELEGRAM_PAIRING_URL`, `SOCIAL_API_JWT_*`, `SOCIAL_API_ALLOWED_AZP`, `CONNECTOR_SHARED_SECRET`, `DATABASE_URL`, `SOCIAL_ACCOUNTS_FILE`, `SOCIAL_IDENTITY_BINDINGS_FILE`). Detalle, códigos de error y JWT contract: **`docs/social-api.md`**; superficies registradas: `http.social-api.*` en `CONTRACTS.yaml`. Encendido = PR del operador tras el PR2 de SC-705 y el mapper Audience de SC-1198 historia 0. Los QR de la casa (`/api/v1/auth/qr`, `/api/v1/me` de los conectores) son superficie DISTINTA e intacta (diseño D6).

## Estructura

Tras el refactor del 2026-05-07 (commit `6791fae`), todo bajo carpetas dedicadas:
- `connectors/{whatsapp-web,telegram,telegram-sync,instagram}/` — `whatsapp-web` (Baileys) sirve ambas cuentas de WhatsApp vía dos Deployments
- `mcp-server/`, `shared/`

## Conectores (estado 2026-05-08)

| Conector | Puerto | Estado | Notas |
|----------|--------|--------|-------|
| WhatsApp Web personal | 3001 | ✅ | Baileys, número personal; sesión en PVC `whatsapp-session-data` |
| WhatsApp Web professional | 3001 | ✅ | Baileys, número de negocio; deploy `whatsapp-connector-professional`, PVC `whatsapp-session-data-professional` |
| WhatsApp Web leila | 3001 | 🟡 desplegada, sin emparejar | Baileys, número de Leila (SC-1144 fase 2); deploy `whatsapp-connector-leila`, PVC `whatsapp-session-data-leila` (arranca vacío → pedirá QR por LAN en `whatsapp-leila.lan.e-dani.com/qr/page`) |
| Telegram | 3002 | ✅ | gramjs (send + realtime); personal + professional |
| Telegram-sync | 3080 | ✅ | telethon, ingestion → Postgres |
| Instagram | 3003 | ✅ 2 cuentas | skirmshop (~7.135), barbelpapis (~14.949) |
| MCP server (interno) | 3000 | ✅ | |
| MCP SSE (público) | 3010 | ✅ | Bearer token |
| social-api (SC-1197) | 3020 | ⏸ inerte (`replicas: 0`, `SOCIAL_PAIRING_API=off`) | imagen mcp-server; única cara de la API de emparejamientos por `sub`, solo in-cluster desde ns `messages` / `app: dgx-messages` (netpol `whatsapp-mcp-allow-messages-social-api`), sin IngressRoute; verifica el JWT |
| whatsapp-pairing (SC-1197) | 3001 | ⏸ inerte (`replicas: 0`) | imagen whatsapp-connector; pool baileys por `sub`, `Recreate`, `SESSION_PATH` en `emptyDir` de memoria (persistencia solo en el credential store); solo lo alcanza social-api |
| telegram-pairing (SC-1197) | 3002 | ⏸ inerte (`replicas: 0`) | imagen telegram-connector; pool mtcute por `sub`, `Recreate`, `emptyDir` de memoria; solo lo alcanza social-api |

> **WhatsApp Cloud API eliminado (2026-05-27).** Se sustituyó por una segunda cuenta Baileys. Motivo: coste cero (no Meta) y poder contestar a mano desde el móvil.

## Instagram — DMs bloqueados, resto OK

Estado del conector (puerto 3003, ambas cuentas conectadas):

| Capacidad | Estado | Nota |
|---|---|---|
| Profile / followers | ✅ | |
| Media / posts / reels read | ✅ | |
| Comments read + reply | ✅ | |
| Stories read | ✅ | |
| Publish image / carousel / reel / story | ✅ | Implementado en `instagram-api.ts` |
| Media insights | ✅ | impressions / reach / engagement / saved |
| **DMs (read + send)** | ❌ | Graph API devuelve `data:[]` por permisos |

**Causa del bloqueo de DMs:** los tokens actuales en `.env` (`INSTAGRAM_SKIRMSHOP_ACCESS_TOKEN`, `INSTAGRAM_BARBELPAPIS_ACCESS_TOKEN`) vienen de la app **Skirmshop conector MCP** (`1268684188569802`), que solo tiene `email`+`public_profile`. Sin `instagram_business_manage_messages` Meta no expone conversaciones.

**Solución:** migrar a la app **Skirmshop marketing manager** (`1431837657952463`, Instagram app ID `1869504556900523`), que ya tiene el producto Instagram + Instagram Login.

### Checklist para desbloquear DMs

1. **App Meta — Skirmshop marketing manager (`1431837657952463`)**
   - [ ] Configurar webhook en producto Instagram (URL: `https://<dominio>/api/v1/<account>/webhook`, verify token = `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` del `.env`)
   - [ ] Suscribirse a eventos: `messages`, `messaging_postbacks`, `comments`
2. **Permisos**
   - [ ] `instagram_business_manage_messages` (necesita Advanced Access)
   - [ ] `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`
   - [ ] Añadir `skirmshopes` y `barbelpapis` como **roles → testers** durante App Review
3. **Tokens**
   - [ ] Generar long-lived user token (60d) vía Instagram Login para cada cuenta
   - [ ] Intercambiar por business token para `INSTAGRAM_<ACCOUNT>_ACCESS_TOKEN`
   - [ ] Actualizar `FACEBOOK_APP_ID` y `FACEBOOK_APP_SECRET` con los de la marketing manager
4. **Despliegue**
   - [ ] Actualizar `.env` (`/home/dibanez/mcp-socialmedia/.env`)
   - [ ] `docker compose restart instagram-connector`
   - [ ] Verificar: `curl http://localhost:3003/api/v1/skirmshop/conversations` ya no debería devolver `data:[]`
5. **App Review (producción real, no solo testers)**
   - [ ] Solicitar Advanced Access para `instagram_business_manage_messages`
   - [ ] Grabar screencast del flujo end-to-end
   - [ ] Pasar app de Development → Live

## LLM

Código migrado a **LiteLLM** (commit `07fa1db`). Ollama **eliminado del proyecto** (2026-04-19):
- Servicio, volumen, imagen, env vars y `config/ollama/` quitados
- Proxy LiteLLM local: container `litellm-router` en puerto 4000
- Env vars activos: `LLM_BASE_URL`, `LLM_CHAT_MODEL`

`README.md` y `DEPLOYMENT.md` reescritos el 2026-05-08 con la realidad actual.

## Comandos útiles

```bash
# Ver estado de todos los conectores
for p in 3002 3003 3010 3080 3090; do curl -s http://localhost:$p/health; echo; done
curl -s http://localhost:3001/status   # WhatsApp personal
curl -s http://localhost:3004/status   # WhatsApp Cloud (diferido)

# Contar mensajes por plataforma
docker exec whatsappmcp-postgres-1 psql -U whatsappmcp -d whatsappmcp \
  -c "select platform, count(*) from messages group by platform;"

# Logs en vivo
docker logs -f whatsappmcp-whatsapp-connector-1
docker logs -f telegram-sync
```

## Pendientes técnicos

- **App Instagram "Skirmshop marketing manager"** — desbloquear DMs (checklist arriba)
- **WhatsApp Cloud** — pendiente de teléfono físico
- **Limpiar `deploy/docker-compose.{lab,prod,base,ollama,whatsapp,telegram,mcp-server}.yml`** y `scripts/setup-ollama.sh` (legacy del modelo lab/prod, ya no se usan; el activo es `docker-compose.yml` + `docker-compose.override.yml`)
- **Quitar `version: '3.8'`** del `docker-compose.yml` si aparece (obsoleto en Compose v2)
