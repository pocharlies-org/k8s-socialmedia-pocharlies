# SKIRM-112 · evidencia

Rama `SKIRM-112-hmac` sobre `origin/deploy/prod` = 3cdf251. Todo en el x86 (Node 22.23.3, pnpm 11.18.0).

## Rojo → verde

Los tests se escribieron antes de tocar `main.ts` / `server.ts` y se ejecutaron sobre el código del tronco.

| qué | antes (rojo, código del tronco) | después (verde) |
|---|---|---|
| `connectors/instagram/src/v1-auth.test.ts` (C1, C2, C4, barrido, registro de rechazos); arranca `createInstagramApp` y llama con `fetch` | 7 tests: 1 pasa (`/health`, `/webhook`, callback sin puerta, que ya era cierto), 6 fallan: `GET /api/v1/accounts` sin firma `expected: 401 / actual: 200`; `POST /messages/send` sin firma llega al cliente de Instagram (200); el barrido encuentra todas las rutas de `/api/v1` abiertas; sin clave `expected: 503 / actual: 200`; el registro de rechazos está vacío | 7/7 |
| `mcp-server/src/mcp/server.instagram-signing.spec.ts` (C2, C3) | 6 tests: 4 fallan (GET, POST, hide + DELETE y actor: el conector con puerta no ve firma, `signatureOk: false`); los 2 que pasan (otra clave → 401, conector sin puerta → 200) pasan también sin firmar | 6/6 |
| `instagram-backfill.ts` (sin spec: el módulo ejecuta `main()` al importarse), sonda a mano contra un conector de mentira que verifica el HMAC (`validate-only`) | — | las 5 peticiones del modo de validación llegan firmadas sobre `{}`; sin `CONNECTOR_SHARED_SECRET` sale con código 1 y 0 peticiones |

## Suites completas (último run)

| comando | resultado |
|---|---|
| `pnpm --filter @mcp-socialmedia/instagram-connector test` (construye `shared` antes) | 60 tests, 60 pass, 0 fail (53 + 7 nuevos) |
| `pnpm --filter @mcp-socialmedia/connector test` (whatsapp-web; mueve la puerta a `shared`) | 594 tests, 593 pass, 0 fail, 1 skipped |
| `pnpm --filter @mcp-socialmedia/server test` (jest) | 58 suites pasan, 1 skipped; 703 tests pass, 8 skipped, 0 fail |
| `pnpm --filter @mcp-socialmedia/shared test` · telegram · synapse-bridge | 6/6 · 77/77 · 40/40 |
| `pnpm -r build` | exit 0 |
| `pnpm -r lint` | exit 0; 0 errores (los warnings de siempre; `connector-auth.ts` es código movido tal cual) |
| `pnpm contract:check` · `check-contracts.py --range origin/deploy/prod..HEAD` · `scripts/render-connectors.py --check` | OK, 73 tools · OK · OK |
| `company-duplicados` | `server.instagram-signing.spec.ts` copiaba el conector de mentira de `server.connector-signing.spec.ts`: sacado a `mcp/test-connector.ts` y usado por los dos. Queda un aviso sobre `boot-accounts.test.ts` ↔ `credential-resolution.test.ts` (el `FakeStore`, que ya estaba en el tronco y esta PR no toca; el check lo marca porque el fichero entra en el diff) |

## Criterios

- C1 `v1-auth.test.ts`: `GET /api/v1/accounts` y `POST /api/v1/:account/messages/send` sin firma 401; con firma de otra clave, de otro cuerpo, timestamp fuera de ventana (±400 s) o no numérico, 401; firmadas 200 (la escritura llega al cliente de Instagram solo firmada); `/health`, `GET /webhook` y `/oauth/instagram/callback` siguen sin la puerta. En la lista de `scripts.test` de `connectors/instagram/package.json`.
- C1 barrido: recorre `app._router.stack`; toda ruta de `/api/v1` responde 401 sin firma, también un camino que ninguna ruta sirve, y toda ruta fuera de `/api/v1` tiene que estar en la lista de abiertas (`GET /health`, `GET /oauth/instagram/callback`).
- C2 un GET firma `{}` con `generateHMACSignature` de `shared`, el firmador de `mcp-server`; `server.instagram-signing.spec.ts` lo verifica con `verifyHMACSignature` contra un conector con puerta.
- C3 `instagramCall` firma GET, POST y DELETE; `instagram-backfill.ts` firma sus GET; una llamada firmada a un conector sin puerta funciona; las specs de `instagram-pairing` y de las tools de Instagram siguen verdes sin tocarlas.
- C4 sin clave, vacía, o el valor del repositorio con `CONNECTOR_SECRET_STRICT=true`: 503 en `/api/v1` (con y sin firma) y `warn` al arrancar, `/health` sigue 200; clave propia: funciona y no avisa; valor del repositorio sin el interruptor: aviso y acepta (decisión: ver `50-entrega.md`).
- C5 `credential-resolution.test.ts` y `oauth-pairing.test.ts` sin modificar y en verde; `boot-accounts.test.ts` (ruta por `x-user-sub` contra el almacén) firma sus dos peticiones, que es lo único que cambia.
- C8 `CONTRACTS.yaml` sin tocar; `pnpm contract:check` OK, 73 tools sin cambio.
- C9 `ARCHITECTURE.md` §2, §4 y §8; nota en `.company/changes/skirm-112-instagram-api-hmac.md`.
- C6 y C7 no son de esta PR: orden de despliegue (`sre`) y prueba de `qa` tras la rotación.
