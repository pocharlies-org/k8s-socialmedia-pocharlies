Rol: developer · Fecha: 2026-10-08 · Sesión: 715ef7e4-8c79-4f49-a12d-59a7c4339ea7 · Estado: LISTO

# SKIRM-103 · Entrega

PR: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/234 (rama `SKIRM-103-api-public-hmac` → `deploy/prod`). Evidencia: `.company/evidence/SKIRM-103-api-public-hmac.md`. Esta es la versión del repositorio; la entrega completa está en Jira (SKIRM-103).

## Qué se ha hecho

- `connectors/whatsapp-web/src/api/public-routes.ts` (nuevo): `createPublicRouter(client, secret, {log, now})` con `createHMACAuth` como primer middleware; los tres handlers de `main.ts` movidos sin cambios (comprobado por comparación del cuerpo de cada handler). Registro de rechazos: `[public-api] rejected <método> <ruta> ip=<ip> reason=<missing_headers|stale_timestamp|invalid_signature> suppressed=<n>`, una línea por motivo cada 10 s; la ruta se corta en el primer segmento para no registrar el chatId; nunca cabeceras, cuerpo, firma ni query. El `curl` manual de `main.ts` se sustituye por la receta firmada (comentario del router y `ARCHITECTURE.md` §8).
- `api/auth.ts`: `createHMACAuth(secret, onReject?)`, sin cambios de comportamiento salvo que un timestamp no numérico ya no se salta la ventana de 5 minutos (401).
- `api/auth-qr.ts` (nuevo): `sendCurrentQR` (el cuerpo del handler v1, ahora compartido) y `createAuthQrV2Router` montado en `/api/v2` (`GET /api/v2/auth/qr`, `// CONTRACT:` en su handler). El handler v1 de `controller.ts` llama a `sendCurrentQR`: mismo id de contrato, misma ruta, mismas respuestas.
- `api/qr-routes.ts` (nuevo): `/qr`, `/qr/page`, `/qr/renew` y `/status` movidos de `main.ts` sin cambios para poder probarlos (C4); idénticos modulo `app`→`router`, `ALLOW_WEB_RENEW`→`allowWebRenew`, `SESSION_PATH`→`sessionPath`.
- `shared/src/crypto/connector-secret.ts` (nuevo): `requireConnectorSecret(env?, warn?)`. Ausente o vacía: lanza, el proceso no arranca. El valor por defecto del repositorio: registra un error una vez por proceso y sigue, salvo con `CONNECTOR_SECRET_STRICT=true`, que lo rechaza. Devuelve el valor tal cual (los demás consumidores no lo recortan). Usado por `whatsapp-web/src/main.ts`, `whatsapp-web/src/dashboard-notifier.ts` (en cada firma), `mcp-server/src/mcp/index.ts` y `mcp-server/src/mcp/sse-server.ts`. El interruptor no se añade a ningún manifiesto aquí: se declara por Deployment en `k8s/overlays/prod`, con el pin de su imagen (`ARCHITECTURE.md` §8).
- `mcp-server/src/mcp/server.ts`: `providerGet` firma `{}` con `this.connectorSecret`; los tres firmantes inline usan `this.connectorSecret` en vez de `process.env.CONNECTOR_SHARED_SECRET || ''`.
- `CONTRACTS.yaml`: `http.whatsapp-connector.auth-qr` → `deprecated` (id, value y files intactos; `replaced_by: …auth-qr.v2`, `remove_after: 2027-01-31`), `auth-qr.v2` y `public-chats.v1`, `public-history.v1`, `public-backfill-media.v1` (una por ruta, sin comodín; `anchor` en el literal del router). Trailers `Contract-Change:` en el commit. Nota en `.company/changes/skirm-103-api-public-hmac.md`.
- `ARCHITECTURE.md` §2 (quién firma qué), §4 (dos filas), §8 (firma a mano, interruptor y cómo se activa).

## Cómo se verifica

```sh
pnpm install --frozen-lockfile
pnpm --filter ./connectors/whatsapp-web exec tsx --test src/api/public-routes.test.ts   # C1, C12, C13
pnpm --filter @mcp-socialmedia/connector test      # 564 tests: 563 pass, 1 skipped
pnpm --filter @mcp-socialmedia/server test         # 57 suites, 689 pass, 8 skipped
pnpm -r build && pnpm contract:check && python3 scripts/render-connectors.py --check
```

## Checklist de `00-spec.md`

- [x] C1. 401 sin firma, con firma de otro cuerpo, caducada o con timestamp no numérico; 200 con firma válida; `public-routes.test.ts` en la lista de `scripts.test`.
- [x] C2. `auth-qr.test.ts` (v1), escrito antes de tocar `controller.ts`.
- [x] C3. `GET /api/v2/auth/qr` sin firma 401; con firma, la carga de v1.
- [x] C4. `/qr`, `/qr/page`, `/qr/renew`, `/status` sin credenciales: `qr-routes.test.ts`.
- [x] C5. `providerGet` firma; contra un conector sin puerta funciona (`server.connector-signing.spec.ts`).
- [x] C6. `CONTRACTS.yaml`, trailers, `pnpm contract:check` y el checker de contratos verdes, nota en `.company/changes/`.
- [x] C7. `pnpm -r build` y las suites de todos los paquetes verdes (por paquete); `render-connectors.py --check` verde.
- [x] C8. `ARCHITECTURE.md` §2, §4 y §8.
- [x] C9. Cuadro de consumidores, abajo.
- [x] C10. `connectors/telegram` sin tocar.
- [x] C11 (en la forma acordada con architect y security). Clave ausente o vacía: el proceso no arranca (`whatsapp-web`, `mcp-sse`); el valor por defecto del repositorio avisa una vez y arranca, y con `CONNECTOR_SECRET_STRICT=true` no arranca. Probado en la función y en los arranques reales (`main.ts`, `index.ts`, `sse-server.ts`). Sin `|| 'dev-secret-change-in-production'` ni `|| ''` en `whatsapp-web` ni `mcp-server`.
- [x] C12. Registro de rechazos probado con el logger capturado.
- [x] C13. Las pruebas de C1 usan el firmador de `providerGet` (`generateHMACSignature` de `shared`), `req.body === {}`, POST sin cuerpo con query, firma de otro cuerpo, timestamp fuera de ventana.
- [ ] C14. No ejecutado: de qa, con el interruptor estricto activado en los Deployments (un GET firmado con el valor por defecto a `/api/public/chats` → 401 en cada conector).
- [ ] C15. No ejecutado: los pines y el interruptor los hace release por Deployment.

## Consumidores (C9)

| ruta | consumidor | ¿firma? | evidencia |
|---|---|---|---|
| `GET /api/public/chats`, `GET /api/public/history/:chatId` | `mcp-sse` y código de `mcp-server` (`providerGet`) | antes no; ahora sí (`{}`) | `server.connector-signing.spec.ts` |
| ídem | `dgx-infra/services/dashboard/api/routes_history.py:92,109` (`WA_URL=http://localhost:3001`) | no | `sre`: llamada muerta; no se migra |
| `POST /api/public/backfill-media` | ninguno | — | `sre`: ningún workload lo referencia |
| `GET /api/v1/auth/qr` (v1) | ninguno | no | sin cambios |
| `GET /api/v2/auth/qr` | ninguno (nace sin consumidores) | sí | — |
| CronJobs de brain y voice, `social-api`, Job migrador | no llegan a `providerGet` ni al helper | — | `grep` de `MCPServer`/`providerGet` en `src/jobs`, `src/infrastructure`, `src/social-api` |

## Reutilizado

- `createHMACAuth` (`connectors/whatsapp-web/src/api/auth.ts`): extendido con `onReject?`; ni `access.ts` del fork ni segundo esquema.
- `generateHMACSignature` / `verifyHMACSignature` (`shared/src/crypto/encryption.ts`): el firmador de `providerGet` y de los tests, y el verificador del conector falso de `mcp-server`.
- `MCPServer.connectorSecret` (ya asignado desde el constructor): ahora lo usan `providerGet` y los tres firmantes inline.
- Patrones de test: `pairing/app.test.ts` (`express()` + `fetch` en puerto efímero), `test-env.ts`, `useTestAccounts` y `Object.create(MCPServer.prototype)` (`server.statuses.spec.ts`), specs de `shared` dentro del jest de `mcp-server` (`session-store/*.spec.ts`).
- Búsquedas: `git grep -n "dev-secret-change-in-production"`, `git grep -n "api/public"`, `grep -rn "CONNECTOR_SHARED_SECRET" --include=*.ts`, `rg "api/public/(chats|history|backfill-media)"` en los clones de `~/k8s`.
- Escrito nuevo y por qué: `public-routes.ts`, `auth-qr.ts` (ruta v2 y carga compartida), `qr-routes.ts` (movido, solo para poder probar C4), `connector-secret.ts` (no existía helper de validación; `social-api/env.ts` y `pairing` comprueban a su manera y devuelven `null`/503) y los tests.

## Desviaciones

- `whatsapp-web/src/dashboard-notifier.ts` también usa el helper (C11 pide que no quede ningún valor cableado en `whatsapp-web`): sin clave utilizable no firma ni envía; `sign` pasa dentro del `try` para no lanzar a los `void` que lo llaman.
- `test-env.ts` da `CONNECTOR_SHARED_SECRET=test-connector-secret` por defecto: `presence.test.ts` ejercita el notifier y necesita una clave.
- `server.lid.spec.ts` y `server.canonical-v2.acceptance.spec.ts` construían `MCPServer` sin secreto (el `|| ''` del entorno lo tapaba): ahora lo reciben.
- La spec llama "`mcp-server` (:3000)" al cliente que firma: el Deployment `mcp-server` es el ingestor (`src/main.ts`); el que firma y pasa por el helper es `mcp-sse`. `ARCHITECTURE.md` lo dice así.
- El aviso del helper sale por `console.error` (nivel error en el log), con un mensaje que nombra `CONNECTOR_SHARED_SECRET`, el valor por defecto y el interruptor.

## No ejecutado

- `pnpm -r test` de una sola vez (sí paquete a paquete, todos).
- C14 y C15; la prueba en vivo con un conector real; el `openssl` de la receta de firma a mano contra un pod.

## Riesgos

- Activar el interruptor reinicia el Deployment que lo recibe (los tres conectores de WhatsApp, SKIRM-88, límite 1Gi; `mcp-sse` es `Recreate`): va en el mismo commit del overlay que el pin de su imagen, nunca en `base/`.
- Un consumidor no enumerado de `/api/public/*` dejaría de funcionar; saldría en el log de rechazos.
- La firma no liga método, ruta ni query, y no hay caché de repetición (el esquema de `/api/v1`); `GET /api/v1/auth/qr` v1 sigue sin firma hasta 2027-01-31.

## Documentos que reflejan el cambio

`ARCHITECTURE.md` §2, §4 y §8, `CONTRACTS.yaml` y `.company/changes/skirm-103-api-public-hmac.md`.
