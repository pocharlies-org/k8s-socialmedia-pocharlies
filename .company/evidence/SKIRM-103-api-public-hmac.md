# SKIRM-103 · evidencia

Rama `SKIRM-103-api-public-hmac` sobre `origin/deploy/prod` = 5ed41bc. Todo en el x86 (Node 22.23.3, pnpm 11.18.0), copia de trabajo limpia salvo estos cambios.

## Rojo → verde

| qué | antes (rojo) | después (verde) |
|---|---|---|
| `src/api/public-routes.test.ts` (C1, C12, C13), módulo con los handlers movidos y SIN puerta | 12 tests: 4 pasan, **8 fallan**; `sin firma → 401` da `expected: 401 / actual: 200` en las tres rutas (el estado de hoy) | 12/12 |
| `src/api/auth-qr.test.ts` v1 (C2), escrito antes de tocar `controller.ts` | 2/2 sobre el código sin tocar (caracterización) | 5/5 con los 3 de v2 (C3); antes de crear `api/auth-qr.ts` la importación falla con `ERR_MODULE_NOT_FOUND` (no hay ruta v2) |
| `mcp-server/src/mcp/server.connector-signing.spec.ts` (C5, C11) sobre `server.ts` sin tocar | 5 de 7 fallan: `providerGet` → `Provider query failed (401)` contra un conector con puerta (no firmaba); los tres firmantes inline → 401 (firmaban con `''`) | 7/7 |
| `mcp-server/src/mcp/connector-secret.spec.ts` (C11), arranques de `index.ts` y `sse-server.ts` | los dos arranques **llegan a la base de datos** (`ECONNREFUSED`) sin clave, con clave vacía y con el placeholder | 9/9: sin clave utilizable el proceso muere nombrando `CONNECTOR_SHARED_SECRET` antes de tocar la base de datos; con una clave válida pasa el guard y solo falla la base de datos inalcanzable |
| `src/startup-guard.test.ts` (C11), notifier sobre el código viejo | `not ok`: el notifier firmaba con el placeholder y enviaba | 2/2 |

## Suites completas (copia del último run)

| comando | resultado |
|---|---|
| `pnpm --filter @mcp-socialmedia/connector test` (construye `shared` antes) | **562 tests, 561 pass, 0 fail, 1 skipped** (el tronco: 538, 536 pass, 1 fail —`criterio 1f: loggedOut`, temporizadores, lo arregla #232—, 1 skipped; +24 = 5 + 12 + 5 + 2) |
| `pnpm --filter @mcp-socialmedia/server test` (jest) | **57 suites pasan, 1 skipped; 683 tests pass, 8 skipped, 0 fail** |
| `pnpm --filter @mcp-socialmedia/shared test` | `echo 'No tests configured'`: shared no tiene runner; su helper lo prueba el jest de mcp-server, como los specs de `session-store` |
| `pnpm -r build` | exit 0 |
| `pnpm --filter shared --filter connector --filter server run lint` | exit 0; 0 errores (9 + 799 + 1240 warnings, los de siempre; los nuevos son del código movido tal cual) |
| `pnpm contract:check` | `Socialmedia contract OK: sha256:e30a4521… (73 tools)` |
| `python3 ~/.config/git/check-contracts.py --repo .` | `contracts: OK (97 entries)`; la nota restante (`metric.brain-windows.refused-deletes.v1`, sin marcador) ya estaba |
| `python3 scripts/render-connectors.py --check` | exit 0 |

Flaky ajeno visto en un run intermedio: `write-back: saveCreds bursts coalesce…` (`credential-session.test.ts`, temporizadores reales; pasa 10/10 dos veces solo). Es la familia que arregla #232 (SKIRM-114).

## Criterios

- C1 `public-routes.test.ts`: sin firma 401 (3 rutas), firmada 200, otro cuerpo / otra clave / ventana → 401; en la lista de `scripts.test`.
- C2 `auth-qr.test.ts` v1: 404 y 200 `{qrCode, expiresAt}` sin credencial, escrito contra `controller.ts` sin tocar.
- C3 `auth-qr.test.ts` v2: sin firma 401; firmado = payload de v1 (200 y 404).
- C4 `qr-routes.test.ts`: `/status`, `/qr`, `/qr/page`, `/qr/renew` sin credencial; compuesta como `main.ts`, las puertas no pasan de su prefijo. Los cuatro handlers se movieron de `main.ts` a `api/qr-routes.ts` sin cambios (comprobado: idéntico salvo `app`→`router`, `ALLOW_WEB_RENEW`→`allowWebRenew`, `SESSION_PATH`→`sessionPath`).
- C5 `server.connector-signing.spec.ts`: `providerGet` firma `{}`; contra un conector sin puerta funciona; los specs de lectura de chats e historial que ya existían pasan.
- C6 `CONTRACTS.yaml`: auth-qr deprecated (id y value intactos), auth-qr.v2, tres `.v1` por ruta, marcadores `// CONTRACT:`, trailers en el commit, nota en `.company/changes/`.
- C7 `pnpm -r test` (por paquete, arriba) y `render-connectors.py --check`.
- C8 `ARCHITECTURE.md` §2, §4, §8.
- C9 cuadro de consumidores en `50-entrega.md`.
- C10 `connectors/telegram` sin tocar.
- C11 `requireConnectorSecret` + arranques; `grep -rn "|| 'dev-secret-change-in-production'" connectors/whatsapp-web mcp-server` sin resultados (el placeholder solo aparece en los cuatro tests que comprueban que se rechaza, y en `shared`).
- C12 `public-routes.test.ts`: línea con método, ruta, IP y motivo; sin cabeceras, cuerpo, firma, query ni chatId; una por motivo cada 10 s con `suppressed=N`.
- C13 las pruebas de C1 firman con `generateHMACSignature` de `@mcp-socialmedia/shared` (el de `providerGet`) sobre `{}` y cubren el POST sin cuerpo con query.
- C14, C15: **no ejecutados**, son de qa y del release tras la rotación de SC-2092.
