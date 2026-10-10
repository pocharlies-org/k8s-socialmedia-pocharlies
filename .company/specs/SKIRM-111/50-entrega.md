Rol: developer · Fecha: 2026-10-10 · Sesión: 715ef7e4-8c79-4f49-a12d-59a7c4339ea7 · Estado: LISTO

# SKIRM-111 · Entrega (parte socialmedia)

PR: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/251 (rama `SKIRM-111-hmac` → `deploy/prod`, con `origin/deploy/prod` = 523a9e8 fusionado). Evidencia: `.company/evidence/SKIRM-111.md`. Parte de `dgx-infra` (el script del host, C3) y el fichero de secreto (`devops`): fuera de esta PR.

## Qué se ha hecho

- `connectors/telegram/src/api/public-routes.ts` (nuevo): `createPublicRouter(client, secret, {log, now})` con `createHMACAuth` de `shared` como primer middleware; `dialogs`, `messages/:chatId` y `send/:chatId` salen de `main.ts` con el mismo cuerpo. La puerta va antes de `requireSending`: sin firma, 401, nunca 403.
- `shared/src/crypto/connector-auth.ts`: `createHMACAuth` y `createHMACRejectLog` son los de SKIRM-112 (#249, ya fusionada: `origin/deploy/prod` = 523a9e8 está fusionado en la rama); el router de Telegram los usa y no hay otra copia de la puerta. `test-connector.ts` es el de #249 con el formato de prettier, que el lint de `mcp-server` exige. En `ARCHITECTURE.md` §2, §4 y §8 conviven los textos de Instagram y de Telegram.
- `telegram-sync`: `ConnectorClient.send` firma el JSON compacto que envía. `mcp-server`: `server.telegram-signing.spec.ts` (el `providerGet` ya firmaba).
- `requireConnectorSecret()` en `telegram` (`main.ts`) y `whatsapp-cloud` (`main.ts`). El notifier del dashboard pasa a `shared/src/utils/dashboard-notifier.ts` (el de whatsapp-web, sin cambios) para no tener dos copias.
- `CONTRACTS.yaml`: tres `.v1` (`http.telegram-connector.public-{dialogs,messages,send}.v1`), marcadores `// CONTRACT:`, trailers.
- `ARCHITECTURE.md` §2, §4, §6 y §8; `.company/changes/skirm-111-api-public-hmac-telegram.md`.

## Cómo se verifica

```sh
pnpm install --frozen-lockfile
pnpm --filter ./connectors/telegram exec tsx --test src/api/public-routes.test.ts   # C1
pnpm --filter ./connectors/telegram test && pnpm --filter ./connectors/whatsapp-cloud test
python -m pytest connectors/telegram-sync/tests   # con TELEGRAM_SYNC_TEST_DATABASE_URL (PostgreSQL 16)
pnpm -r build && pnpm contract:check && python3 scripts/render-connectors.py --check
```

## Checklist de `00-spec.md`

- [x] C1. Tres rutas: sin firma 401, otro cuerpo / otra clave / ventana → 401, firmada 200; mismo firmador que `providerGet`.
- [x] C2. `telegram-sync` firma el envío; test Python con vectores fijos contra el firmador del conector (suite completa con PostgreSQL 16, sin saltos).
- [ ] C3. Script del host: PR aparte en `dgx-infra`.
- [x] C4. Guard de arranque en telegram y whatsapp-cloud; tests de cada arranque.
- [ ] C5, C6: de `sre`/`qa` tras el despliegue y la rotación.
- [x] C7. Tres entradas `.v1`; `pnpm contract:check` verde; 73 tools.
- [x] C8. `ARCHITECTURE.md` §2 y §8.

## Reutilizado

- `createHMACAuth` y el registro de rechazos de SKIRM-112 en `shared/src/crypto/connector-auth.ts`; `generateHMACSignature` y `requireConnectorSecret` de `shared`; `requireSending` de `connectors/telegram/src/api/controller.ts`; el patrón de `connectors/whatsapp-web/src/api/public-routes.ts` y de sus tests.
- Buscado: `rg -n "api/public|dev-secret-change-in-production|CONNECTOR_SHARED_SECRET"`, `rg -n "dashboard-notifier"`, `rg --files | rg "auth|public-routes"`.
- Nuevo: `public-routes.ts` de Telegram (los handlers movidos), sus tests y el firmador Python sobre bytes (nada lo cubría).
