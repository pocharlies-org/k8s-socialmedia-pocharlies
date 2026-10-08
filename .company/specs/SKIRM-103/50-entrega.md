Rol: developer · Fecha: 2026-10-08 · Sesión: 715ef7e4-8c79-4f49-a12d-59a7c4339ea7 · Estado: LISTO

# SKIRM-103 · Entrega

PR: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/234 (rama `SKIRM-103-api-public-hmac` → `deploy/prod`, desde 5ed41bc). Evidencia: `.company/evidence/SKIRM-103-api-public-hmac.md` (en la PR).

**PARA SECURITY:** al revisar `controller.ts` para esta historia he visto dos rutas de `/api/v1` del conector de WhatsApp que **no montan `auth`**: `GET /api/v1/history/:chatId` (devuelve mensajes del chat, `controller.ts:1308`) y `POST /api/v1/history/sync` (lanza la descarga de historial, `:1275`). Es el mismo dato que `/api/public/history/:chatId`, que esta PR cierra. No tienen consumidor en el repo ni en los clones barridos (`rg "api/v1/history"` en dgx-infra, jarvis, synapse, labels, control-panel, openclaw, agentgateway, infra: nada). El borde `.lan` ya va tras `sso-chain` (SKIRM-110) y el público también, pero cualquier pod del cluster llega al puerto 3001 (NetworkPolicy del ns, medido por sre). ¿Se cierran con `auth` en una historia propia (cambia una superficie sin entrada en `CONTRACTS.yaml`) y cuentan para el cierre de F3? No las toco: fuera del alcance de la spec.

## Qué se ha hecho

- `connectors/whatsapp-web/src/api/public-routes.ts` (nuevo): `createPublicRouter(client, secret, {log, now})` con `createHMACAuth` como primer middleware; los tres handlers de `main.ts:276-330` movidos sin cambios (comprobado por comparación del cuerpo de cada handler). Registro de rechazos (F3-4): `[public-api] rejected <método> <ruta> ip=<ip> reason=<missing_headers|stale_timestamp|invalid_signature> suppressed=<n>`, una línea por motivo cada 10 s; la ruta se corta en el primer segmento para no registrar el chatId; nunca cabeceras, cuerpo, firma ni query. El `curl` manual de `main.ts:306` se sustituye por la receta firmada en el comentario del router y en `ARCHITECTURE.md` §8 (la receta del `openssl` no la he ejecutado contra un conector real; sí contra el router en los tests con el mismo mensaje `ts:{}`).
- `api/auth.ts`: `createHMACAuth(secret, onReject?)`: parámetro opcional, comportamiento igual sin él.
- `api/auth-qr.ts` (nuevo): `sendCurrentQR` (el cuerpo del handler v1, ahora compartido) y `createAuthQrV2Router` montado en `/api/v2` (`GET /api/v2/auth/qr`, `// CONTRACT:` en su handler). `controller.ts`: el handler v1 llama a `sendCurrentQR`; mismo id de contrato, misma ruta, mismas respuestas.
- `api/qr-routes.ts` (nuevo): `/qr`, `/qr/page`, `/qr/renew` y `/status` movidos de `main.ts` **sin cambios** para poder probarlos (C4); idénticos modulo `app`→`router`, `ALLOW_WEB_RENEW`→`allowWebRenew`, `SESSION_PATH`→`sessionPath`.
- `shared/src/crypto/connector-secret.ts` (nuevo): `requireConnectorSecret(env?)` lanza si `CONNECTOR_SHARED_SECRET` falta, está vacía o es el placeholder; devuelve el valor tal cual (los demás consumidores no lo recortan). Usado por `whatsapp-web/src/main.ts`, `whatsapp-web/src/dashboard-notifier.ts`, `mcp-server/src/mcp/index.ts` y `mcp-server/src/mcp/sse-server.ts`.
- `mcp-server/src/mcp/server.ts`: `providerGet` firma `{}` con `this.connectorSecret`; los tres firmantes inline (`handleSendApprovedReply`, `handleSendMessage`, `handleRenewQRCode`) usan `this.connectorSecret` en vez de `process.env.CONNECTOR_SHARED_SECRET || ''`.
- `CONTRACTS.yaml`: `http.whatsapp-connector.auth-qr` → `deprecated` (id, value y files intactos; `replaced_by: …auth-qr.v2`, `remove_after: 2027-01-31`, 115 días), `auth-qr.v2` (`/api/v2/auth/qr`) y `public-chats.v1`, `public-history.v1`, `public-backfill-media.v1` (una por ruta, sin comodín; `anchor` en el literal del router porque el valor completo no aparece en el fichero). Trailers `Contract-Change:` en el commit. Nota en `.company/changes/skirm-103-api-public-hmac.md`.
- `ARCHITECTURE.md` §2 (quién firma qué), §4 (dos filas), §8 (firma a mano, límite de la firma, orden de despliegue).

## Decisión pedida: el guard en `mcp-server`

Guard que **falla cerrado** en `mcp-server`, no aviso, y el pin del paso 1 espera a la rotación igual que el del paso 2. Motivos: (1) es la condición F3-2 de security, cuyo veredicto es final; (2) en producción el guard solo afecta a `mcp-sse` (`sse-server.ts`): el Deployment `mcp-server` ejecuta `src/main.ts`, el ingestor, que no firma, y los CronJobs de brain/voice, `social-api` y el Job migrador no importan `index.ts`, `sse-server.ts` ni `MCPServer` (comprobado con `grep`); (3) la rotación de SC-2092 obliga a reiniciar `mcp-sse` para que lea la clave nueva, así que la imagen nueva viaja en ese reinicio y no cuesta uno más; (4) un aviso hasta la rotación obligaría a una segunda PR y a un segundo reinicio de `mcp-sse` para endurecerlo, y mientras tanto un proceso que firma con una clave pública seguiría arrancando. Coste: el paso 1 deja de poder ir "antes". Riesgo: `mcp-sse` es `Recreate`, `hostPort: 3010` y backend de `/social`: pinarlo con el Secret aún en el placeholder tumba `social_*`. Por eso el orden es: Secret rotado → comprobación por sha256 de que ya no es el placeholder → `mcp-server` → conectores uno a uno.

## Cómo se verifica

```sh
cd <copia limpia de la rama>
pnpm install --frozen-lockfile
pnpm --filter ./connectors/whatsapp-web exec tsx --test src/api/public-routes.test.ts   # C1, C12, C13
pnpm --filter @mcp-socialmedia/connector test      # 562 tests: 561 pass, 1 skipped
pnpm --filter @mcp-socialmedia/server test         # 57 suites, 683 pass, 8 skipped
pnpm -r build && pnpm contract:check && python3 scripts/render-connectors.py --check
```

Tras la rotación y los pines (qa/release, no ejecutado aquí): `social_list_conversations` sigue leyendo tras el de `mcp-sse`; `curl` sin firma a `/api/public/chats` desde un pod de prueba da 401, la lectura firmada 200, la página del QR abre tras SSO; y C14: un GET firmado con el placeholder da 401 en los tres conectores.

## Checklist de `00-spec.md`

- [x] C1. 401 sin firma, con firma de otro cuerpo, caducada; 200 con firma válida; `public-routes.test.ts` en la lista de `scripts.test`.
- [x] C2. `auth-qr.test.ts` (v1), escrito antes de tocar `controller.ts`: 2/2 sobre el código sin cambios y tras el cambio.
- [x] C3. `GET /api/v2/auth/qr` sin firma 401; con firma, la carga de v1.
- [x] C4. `/qr`, `/qr/page`, `/qr/renew`, `/status` sin credenciales: `qr-routes.test.ts` (tras mover los handlers sin cambios).
- [x] C5. `providerGet` firma; contra un conector sin puerta funciona (`server.connector-signing.spec.ts`); los specs de lectura existentes pasan.
- [x] C6. `CONTRACTS.yaml` (diff mínimo), trailers, `pnpm contract:check` y el checker de contratos verdes, nota en `.company/changes/`.
- [x] C7. `pnpm -r build` verde y las suites de todos los paquetes verdes, ejecutadas por paquete (no `pnpm -r test` de una sola vez): connector 562/561, server 683 (8 skipped de siempre), instagram 41, telegram 66, synapse-bridge 40, whatsapp-cloud y workers sin fallos, shared sin runner; `render-connectors.py --check` verde.
- [x] C8. `ARCHITECTURE.md` §2 y §8 (y §4).
- [x] C9. Cuadro de consumidores, abajo.
- [x] C10. `connectors/telegram` sin tocar.
- [x] C11. Helper + arranques probados; `grep -rn "|| 'dev-secret-change-in-production'" connectors/whatsapp-web mcp-server` sin resultados; `server.ts` ya no firma con `''`.
- [x] C12. Registro de rechazos probado con el logger capturado.
- [x] C13. Las pruebas de C1 usan el firmador de `providerGet` (`generateHMACSignature` de `shared`), `req.body === {}`, POST sin cuerpo con query, firma de otro cuerpo, timestamp fuera de ventana.
- [ ] C14. No ejecutado: es de qa y solo pasa tras la rotación de SC-2092 (un GET firmado con el placeholder a `/api/public/chats` → 401 en los tres conectores).
- [ ] C15. No ejecutado: los pines van en la ventana de la rotación, a cargo de release.

## Consumidores (C9)

| ruta | consumidor | ¿firma? | evidencia |
|---|---|---|---|
| `GET /api/public/chats`, `GET /api/public/history/:chatId` | `mcp-sse` y código de `mcp-server` (`providerGet`: `listConversationsFor`, `canonicalGetConversation`, `canonicalListMessages`) | antes no; **ahora sí** (`{}`) | `server.connector-signing.spec.ts`; sre: el env de ambos Deployments apunta a los tres Services `whatsapp-connector*:3001` |
| ídem | `dgx-infra/services/dashboard/api/routes_history.py:92,109` (`WA_URL=http://localhost:3001`) | no | sre: llamada muerta (sockets del pod solo 9002 y 19914). Mi `rg` en 9 clones: es la única otra referencia. No se migra; si estuviera viva, saldría en el log `[public-api] rejected` |
| `POST /api/public/backfill-media` | ninguno | — | sre: ningún workload lo referencia; solo el `curl` manual del comentario, ya actualizado |
| `GET /api/v1/auth/qr` (v1) | ninguno | no | sre; solo `README.md:103` y `DEPLOYMENT.md:120` (curl manual); sin cambios |
| `GET /api/v2/auth/qr` | ninguno (nace sin consumidores) | sí | — |
| CronJobs de brain, voice, `social-api`, Job migrador | no llegan a `providerGet` ni al guard | — | `grep` de `MCPServer`/`providerGet`/`mcp/server` en `src/jobs`, `src/infrastructure`, `src/social-api`: nada |

No ha aparecido ningún consumidor vivo sin firma que obligue a detenerse. Lo que no puedo descartar desde aquí (igual que sre): un script en un host fuera del cluster.

## Reutilizado

- `createHMACAuth` (`connectors/whatsapp-web/src/api/auth.ts`): extendido con `onReject?` en vez de escribir otra puerta; ni `access.ts` del fork ni segundo esquema.
- `generateHMACSignature` / `verifyHMACSignature` (`shared/src/crypto/encryption.ts`): el firmador de `providerGet` y de los tests, y el verificador del conector falso de `mcp-server`.
- `MCPServer.connectorSecret` (`server.ts:312,370`, ya asignado desde el constructor): ahora lo usan `providerGet` y los tres firmantes inline.
- Patrones de test: `pairing/app.test.ts` (`express()` + `fetch` en puerto efímero), `test-env.ts`, `useTestAccounts` y `Object.create(MCPServer.prototype)` (`server.statuses.spec.ts`), specs de `shared` dentro del jest de `mcp-server` (`session-store/*.spec.ts`).
- `QRHandler.getCurrentQR`, formato de `CONTRACTS.yaml` y de `.company/changes/`.
- Búsquedas: `git grep -n "dev-secret-change-in-production"`, `git grep -n "api/public"`, `grep -rn "CONNECTOR_SHARED_SECRET" --include=*.ts`, `rg "api/public/(chats|history|backfill-media)"` y `rg "api/v1/history"` en los clones de `~/k8s` nombrados arriba, `grep -nE "^\s*router\.(get|post)\(" controller.ts` para ver qué rutas montan `auth`.
- Escrito nuevo y por qué: `public-routes.ts`, `auth-qr.ts` (ruta v2 y payload compartido; no había nada), `qr-routes.ts` (movido, solo para poder probar C4), `connector-secret.ts` (no existía helper de validación; `social-api/env.ts` y `pairing` comprueban a su manera y devuelven `null`/503, que no es "no arrancar") y los tests.
- Duplicados: `company-duplicados` compara con `origin/HEAD` (`main`), que va muy por detrás de `deploy/prod`, y devuelve 91 hallazgos, ninguno en los ficheros nuevos; los que tocan ficheros que edito son bloques que ya estaban (`index.ts`/`sse-server.ts` constantes, firmantes inline de `server.ts`).

## Desviaciones y cosas que el revisor debe ver

- `whatsapp-web/src/dashboard-notifier.ts` también pierde el fallback (C11 exige que no quede ninguno en `whatsapp-web`, aunque F3-2 dejaba los notifiers para SKIRM-111): sin clave utilizable no firma ni envía, y registra un aviso; `sign` pasa dentro del `try` para no lanzar a los `void` que lo llaman.
- `test-env.ts` da `CONNECTOR_SHARED_SECRET=test-connector-secret` por defecto: `presence.test.ts` ejercitaba el notifier sin clave y dependía del placeholder.
- `server.lid.spec.ts` y `server.canonical-v2.acceptance.spec.ts` construían `MCPServer` sin secreto (el `|| ''` del entorno lo tapaba): ahora lo reciben.
- La spec dice "`mcp-server` (:3000)" como cliente que firma: el Deployment `mcp-server` es el ingestor (`src/main.ts`); el que firma y pasa por el guard es `mcp-sse`. `ARCHITECTURE.md` lo dice así.
- El diff de `ARCHITECTURE.md` y `CONTRACTS.yaml` puede chocar con #229/#231 (mismas zonas): el segundo en fusionar rebasa una vez.

## No ejecutado

- `pnpm -r test` de una sola vez (sí paquete a paquete, todos). El tronco tiene un fallo intermitente de temporizadores en `credential-session.test.ts` (lo arregla #232); lo vi en un run intermedio y pasa 10/10 solo.
- C14 y C15 (rotación de SC-2092); la prueba en vivo con un conector real; el `openssl` de la receta de firma a mano contra un pod.
- Jira: no me he asignado la historia ni la he movido de estado (instrucción de la sesión); el bloque Rescate y las etiquetas `session-`/`agent-` no se han puesto por lo mismo.

## Riesgos

- Con el Secret en el placeholder, `mcp-sse` y los conectores con este código no arrancan: no pinar antes de la rotación (la PR en sí no despliega nada).
- Reinicia los tres conectores de WhatsApp (SKIRM-88; límite 1Gi) y `mcp-sse` (`Recreate`).
- Un consumidor no enumerado de `/api/public/*` dejaría de funcionar; saldría en el log de rechazos.
- La firma no liga método, ruta ni query (nota de security); `GET /api/v1/auth/qr` v1 sigue abierto hasta 2027-01-31.

## Documentos que reflejan el cambio

`ARCHITECTURE.md` §2, §4 y §8, `CONTRACTS.yaml` y `.company/changes/skirm-103-api-public-hmac.md`.

Siguiente paso recomendado: `architect` y `qa` sobre la PR; `security` responde el `PARA SECURITY:` de arriba; `release` fija los pines en la ventana de SC-2092.
