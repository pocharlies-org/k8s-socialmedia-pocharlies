# whatsappmcp — Notas para Claude

## Qué es

Servidor MCP multi-plataforma (WhatsApp + Telegram + Instagram) que expone tools a Claude/LLMs por SSE. Almacena mensajes en Postgres+pgvector, usa Redis (cache), MinIO (ficheros) y NATS (event bus). LLM vía LiteLLM.

## Dónde corre

- **Producción actual: k8s namespace `whatsapp-mcp`** (sauvage / ubuntu node)
- ArgoCD app: `socialmedia` → repo `pocharlies/k8s-socialmedia-pocharlies`, branch `deploy/prod`, path `k8s/overlays/prod`
- Promoción: workflow_dispatch en `.github/workflows/release.yml` o tag push
- El stack docker-compose viejo en sauvage `~/mcp-socialmedia/` está parado a propósito desde 2026-05-22 (migración a k8s). NO arrancarlo.
- Imágenes en Harbor: `harbor.e-dani.com/homelab/whatsappmcp-*`

## Multi-account (personal / professional)

El MCP enruta cada call a una de dos cuentas:

| Account | Telegram | WhatsApp |
|---|---|---|
| `personal` (**default**) | `telegram-connector` — sesión `paxanguero` | `whatsapp-connector` — Baileys (número personal) |
| `professional` | `telegram-connector-professional` — sesión `sauvageadminbot` (skirmshop) | `whatsapp-connector-professional` — Baileys (número de negocio) |

- **Ambas cuentas de WhatsApp son Baileys (WhatsApp Web)** — cada una un Deployment con su número, sesión y PVC propia. NO se usa Cloud API (eliminado: el usuario no quiere pagar a Meta y quiere contestar a mano desde el móvil; Baileys es un dispositivo vinculado).
- Para indicarle al MCP qué cuenta usar pasa `account: 'personal' \| 'professional'` en la tool call.
- Default global: `personal`. Si el chat es claramente de skirmshop/business → pasar `professional`.
- Para agentes/sesiones de Claude/Codex/OpenClaw que NO sean específicamente "hogar"/"familia", la guía es: **siempre `account: 'professional'`** salvo que el chat destino sea familiar/personal.
- Vincular el número professional: escanear el QR en `https://whatsapp-pro.e-dani.com/qr/page`.

DB scoping (migración 002): los ids de la cuenta `personal` no llevan prefijo (compat con ~449k filas existentes); los de `professional` van prefijados `professional:`. La columna `account` está indexada para filtros rápidos.

## Almacén de credenciales por usuario (SC-552 + fase 1.5 SC-705)

Decisión CTO 13-09-2026: UN almacén por `sub` del JWT que el AgentGateway verifica en `/social` y reenvía como cabecera `x-user-sub`, con tres adaptadores de canal — no tres almacenes paralelos. Implementación en `shared/src/session-store/` (desde la fase 1.5, 21-09: la consumen DOS runtimes — mcp-server y el conector whatsapp-web —; un solo código que habla con la tabla). Sus specs de regresión corren en el jest de mcp-server (`mcp-server/src/infrastructure/session-store/*.spec.ts`, que compila `shared` antes de testear).

- `credential-store.ts` — tabla `user_channel_credentials` (migración 007, PK `(session_key, channel)`). Persistencia = la DB `whatsappmcp`: sobrevive reinicios del gateway y de los pods. **El payload va CIFRADO en la capa del store** (`put` cifra, `get` descifra; la DB nunca ve texto plano): envelope AES-256-GCM con data-key aleatoria por fila envuelta por la clave maestra `CREDENTIAL_STORE_MASTER_KEY` (base64 de 32 bytes; viaja dentro del item 1Password `whatsapp-mcp` → `envFrom`; formato y justificación del envelope en `payload-crypto.ts`). Fail-closed: sin clave, `put`/`get` lanzan; una fila NO-envelope se rechaza.
- `request-context.ts` — AsyncLocalStorage alrededor de `transport.handleRequest`/`handlePostMessage` en `sse-server.ts` (por POST); expone `x-user-sub`/`x-user-name` al contexto de la tool call. Sin cabecera → contexto vacío. `actorRequestHeaders()` reenvía el actor en las llamadas HTTP del mcp-server a los conectores (SC-705).
- `adapters/` — baileys (directorio multi-file auth-state → `{files: nombre→base64}`), mtcute (session string), instagram (token Graph + ids). Cada canal conserva su formato; el store no lo interpreta.
- `credential-resolver.ts` — `resolveCredential`: (1) cabecera + fila → la fila gana; (2) sin cabecera → ruta legacy exacta, cero lecturas/escrituras; (3) cabecera sin fila → adopt-on-first-use (leer legacy, escribir fila, servir legacy).

**Cableado WhatsApp (fase 1.5, `connectors/whatsapp-web/src/credential-session.ts`)**: un conector por sesión emparejada indexa su sesión por `session_key = <sub>` (o `<sub>:<cuenta>` si un usuario tuviera dos cuentas — convención del tech-lead, el PK ya la soporta). Con `CREDENTIAL_STORE_ENABLED=true` **y** `CREDENTIAL_SESSION_KEY=<sub>`: authDir por sub (`<SESSION_PATH>/by-sub/<key>/baileys-auth`), carga de la fila antes de `connect()` (persistencia tras `rollout restart`, sin QR), write-back OBLIGATORIO de `saveCreds`→`store.put` (debounced, con trailing run) y borrado de la fila en `loggedOut`. Sin `CREDENTIAL_SESSION_KEY` (las cuentas de la casa `personal`/`professional`) o con flag OFF: ruta legacy exacta, cero lecturas/escrituras — criterio de cero regresión.

Despliegue: la migración 007 la aplica el Job PreSync `whatsapp-mcp-migrate` (idempotente, `k8s/base/manifest.yaml`). `CREDENTIAL_STORE_ENABLED=true` SOLO en el overlay `prod` (`k8s/overlays/.../patch-credential-store.yaml`; stg OFF). Pendiente de fase 2: pool multiplexado por `sub` en un solo proceso; inyección de `x-user-sub` en la ruta `/social` del AgentGateway (hoy solo la hacen `/workspace` y `/chat-*` vía `transformations.request.set`).

## Estructura

Tras el refactor del 2026-05-07 (commit `6791fae`), todo bajo carpetas dedicadas:
- `connectors/{whatsapp-web,telegram,telegram-sync,instagram}/` — `whatsapp-web` (Baileys) sirve ambas cuentas de WhatsApp vía dos Deployments
- `mcp-server/`, `shared/`

## Conectores (estado 2026-05-08)

| Conector | Puerto | Estado | Notas |
|----------|--------|--------|-------|
| WhatsApp Web personal | 3001 | ✅ | Baileys, número personal; sesión en PVC `whatsapp-session-data` |
| WhatsApp Web professional | 3001 | ✅ | Baileys, número de negocio; deploy `whatsapp-connector-professional`, PVC `whatsapp-session-data-professional` |
| Telegram | 3002 | ✅ | gramjs (send + realtime); personal + professional |
| Telegram-sync | 3080 | ✅ | telethon, ingestion → Postgres |
| Instagram | 3003 | ✅ 2 cuentas | skirmshop (~7.135), barbelpapis (~14.949) |
| MCP server (interno) | 3000 | ✅ | |
| MCP SSE (público) | 3010 | ✅ | Bearer token |

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
