# SKIRM-103 · evidencia

Rama `SKIRM-103-api-public-hmac` sobre `origin/deploy/prod` = 897435e. Todo en el x86 (Node 22.23.3, pnpm 11.18.0).

## Rojo → verde

| qué | antes (rojo) | después (verde) |
|---|---|---|
| `src/api/public-routes.test.ts` (C1, C12, C13), módulo con los handlers movidos y sin puerta | 4 pasan, 8 fallan: `sin firma → 401` da `expected: 401 / actual: 200` en las tres rutas | 13/13 |
| `public-routes.test.ts`, timestamp no numérico (`abc`, `NaN`) con firma correcta para esa cadena | `expected: 401 / actual: 200` (la ventana de 5 min se saltaba) | 401; arreglo en `createHMACAuth` (`Number.isFinite`) |
| `src/api/auth-qr.test.ts` v1 (C2), escrito antes de tocar `controller.ts` | 2/2 sobre el código sin tocar | 5/5 con los 3 de v2 (C3) |
| `mcp-server/src/mcp/server.connector-signing.spec.ts` (C5) | 5 de 7 fallan: `providerGet` no firmaba (`Provider query failed (401)` contra un conector con puerta) y los tres firmantes inline firmaban con `''` | 7/7 |
| `mcp-server/src/mcp/connector-secret.spec.ts` (C11): ausente/vacía siempre fatal; el valor por defecto del repositorio avisa una vez por proceso y arranca, y con `CONNECTOR_SECRET_STRICT=true` es fatal; arranques reales de `index.ts` y `sse-server.ts` | no compila contra el helper anterior (`requireConnectorSecret` sin segundo argumento: seis `TS2554`) | 15/15 |
| `src/startup-guard.test.ts` (C11): `main.ts` real sin clave / clave vacía / valor por defecto con el interruptor estricto; notifier del dashboard en cada modo | — | 3/3 |

## Suites completas (último run)

| comando | resultado |
|---|---|
| `pnpm --filter @mcp-socialmedia/connector test` (construye `shared` antes) | 564 tests, 563 pass, 0 fail, 1 skipped |
| `pnpm --filter @mcp-socialmedia/server test` (jest) | 57 suites pasan, 1 skipped; 689 tests pass, 8 skipped, 0 fail |
| `pnpm --filter @mcp-socialmedia/shared test` | 6/6 (`meta-signature.test.ts`, de SKIRM-102); el helper de este cambio lo prueba el jest de `mcp-server`, como los specs de `session-store` |
| instagram / telegram / synapse-bridge / whatsapp-cloud / workers | 53/53, 77/77, 40/40, sin fallos, sin fallos |
| `pnpm -r build` | exit 0 |
| lint de shared, connector y server | exit 0; 0 errores (los warnings de siempre; los nuevos son del código movido tal cual) |
| `pnpm contract:check` · checker de contratos · `scripts/render-connectors.py --check` | OK · OK (99 entradas) · OK |

## Criterios

- C1 `public-routes.test.ts`: sin firma 401 (3 rutas), firmada 200, otro cuerpo / otra clave / ventana / timestamp no numérico → 401; en la lista de `scripts.test`.
- C2 `auth-qr.test.ts` v1: 404 y 200 `{qrCode, expiresAt}` sin credencial, escrito contra `controller.ts` sin tocar.
- C3 `auth-qr.test.ts` v2: sin firma 401; firmado = carga de v1.
- C4 `qr-routes.test.ts`: `/status`, `/qr`, `/qr/page`, `/qr/renew` sin credencial; compuesta como `main.ts`, las puertas no pasan de su prefijo. Los handlers se movieron de `main.ts` sin cambios.
- C5 `server.connector-signing.spec.ts`: `providerGet` firma `{}`; contra un conector sin puerta funciona.
- C6 `CONTRACTS.yaml`: `auth-qr` deprecated (id y value intactos), `auth-qr.v2`, tres `.v1` por ruta, marcadores `// CONTRACT:`, trailers, nota en `.company/changes/`.
- C7 builds y suites de todos los paquetes (por paquete) verdes; `render-connectors.py --check` verde.
- C8 `ARCHITECTURE.md` §2, §4 y §8.
- C10 `connectors/telegram` sin tocar.
- C11 `requireConnectorSecret(env?, warn?)`: ausente o vacía siempre fatal; el valor por defecto del repositorio avisa una vez y arranca, y es fatal con `CONNECTOR_SECRET_STRICT=true`; probado en la función y en los arranques reales. Sin `|| 'dev-secret-change-in-production'` ni `|| ''` en `connectors/whatsapp-web` ni `mcp-server`.
- C12 registro de rechazos: método, ruta, IP y motivo; sin cabeceras, cuerpo, firma, query ni chatId; una por motivo cada 10 s.
- C13 las pruebas de C1 firman con `generateHMACSignature` de `@mcp-socialmedia/shared` (el de `providerGet`) sobre `{}`.
- C14 y C15: de qa y release, con el interruptor estricto activado; no ejecutados aquí.
