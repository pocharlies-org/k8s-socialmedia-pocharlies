# SKIRM-111 · evidencia

Rama `SKIRM-111-hmac` con `origin/deploy/prod` = 523a9e8 fusionado (SKIRM-112, #249; el rojo se midió antes, sobre 3cdf251). Todo en el x86 (Node 22.23.3, pnpm 11.18.0, Python 3.12.3, PostgreSQL 16 en un contenedor efímero para `telegram-sync`).

## Rojo → verde

El rojo se midió sobre un árbol del tronco al que se copiaron los tests nuevos: para el router, un `public-routes.ts` con los tres handlers de `main.ts` sin la puerta (lo que el tronco sirve).

| qué | antes (rojo) | después (verde) |
|---|---|---|
| `connectors/telegram/src/api/public-routes.test.ts` (C1) | 2 pasan (firmadas 200, vectores), 5 fallan: `sin firma → 401` da `expected: 401 / actual: 200` en las tres rutas; otro cuerpo / otra clave / ventana → 200; con el envío cerrado sin firma llega a `403` en vez de `401`; ningún rechazo se registra (`expected: 2 / actual: 0`) | 7/7 |
| `connectors/telegram/src/startup-guard.test.ts` (C4) | 3/3 fallan: `main.ts` sin clave sigue hasta pedir `TELEGRAM_API_ID`, sin nombrar `CONNECTOR_SHARED_SECRET` | 1/1 (el notifier lo cubre el test de `whatsapp-web`, ahora sobre `shared`) |
| `connectors/whatsapp-cloud/src/startup-guard.test.ts` (C4) | 1/1 falla: sin clave arranca | 1/1 |
| `connectors/telegram-sync/tests/test_connector_signing.py` (C2) | 2 pasan (firmador, lecturas), 2 fallan: `ConnectorClient.send` no lleva `x-connector-signature` (`KeyError`) | 4/4 |
| `mcp-server/src/mcp/server.telegram-signing.spec.ts` | `providerGet` ya firmaba: es cobertura nueva, verde en el tronco y aquí | 3/3 |

Los vectores de firma son los mismos literales en `public-routes.test.ts` (firmador del conector, `generateHMACSignature` de `shared`) y en `test_connector_signing.py` (firmador de `telegram-sync`): clave `vector-secret-not-a-real-key`, timestamp `1760000000`, cuatro cuerpos (`{}`, texto, texto con escapes y no ASCII, emoji).

## Suites completas (último run, sobre el HEAD de la rama)

| comando | resultado |
|---|---|
| `pnpm --filter ./connectors/telegram test` (construye `shared` antes) | 85 tests, 85 pass, 0 fail, 0 skipped |
| `pnpm --filter ./connectors/whatsapp-cloud test` | 1/1 |
| `pnpm --filter @mcp-socialmedia/shared test` | 6/6 |
| `pnpm --filter ./connectors/whatsapp-web test` (`@mcp-socialmedia/connector`) | 594 tests, 593 pass, 0 fail, 1 skipped (el de siempre) |
| `pnpm --filter @mcp-socialmedia/server test` (jest) | 58 suites pasan, 1 skipped; 700 tests pass, 8 skipped, 0 fail |
| `TELEGRAM_SYNC_TEST_DATABASE_URL=… python -m pytest -p no:cacheprovider -rs tests` (PostgreSQL 16) | 40 passed, 0 skipped |
| `pnpm -r build` | exit 0 |
| `pnpm -r lint` | exit 0; 0 errores (los warnings de siempre) |
| `pnpm contract:check` · `check-contracts.py --range origin/deploy/prod..HEAD` · `scripts/render-connectors.py --check` | OK (73 tools) · OK (104 entradas) · OK |
| `company-duplicados --base origin/deploy/prod` | sin duplicación nueva |

## Criterios

- C1 `public-routes.test.ts`: sin firma 401 en las tres rutas y en una ruta desconocida (sin llegar a Telegram; el cuerpo vacío de un envío ya no llega a `Missing text`), firmadas como `providerGet` (`{}`) 200 con el límite en la query, `send` firmado sobre su cuerpo 200, otro cuerpo / otra clave (también el valor por defecto del repositorio) / ventana de 5 min / timestamp no numérico → 401, con el envío cerrado 401 sin firma y 403 con ella; registro de rechazos sin cabeceras, cuerpo, firma, chatId ni query, una línea por motivo cada 10 s. En la lista de `scripts.test` de `connectors/telegram/package.json`. `sending-gate.test.ts` monta ahora el router real.
- C2 `test_connector_signing.py`: vectores fijos, `send` firma los mismos bytes que envía, la lectura sigue firmando `{}`; la suite entera con PostgreSQL 16, sin saltos.
- C3: PR de `dgx-infra` aparte (no está en esta).
- C4 `startup-guard.test.ts` de `telegram` y de `whatsapp-cloud`: `main.ts` real sin clave, con clave vacía y con el valor por defecto estricto no arranca y nombra `CONNECTOR_SHARED_SECRET`; con el valor por defecto sin interruptor, `telegram` pasa el guard (avisa y muere después por no tener credenciales de Telegram). La función compartida la cubre `mcp-server/src/mcp/connector-secret.spec.ts`; el notifier, `whatsapp-web/src/startup-guard.test.ts`.
- C5 y C6: de `sre`/`qa` tras los pins y la rotación; no ejecutados aquí.
- C7 `CONTRACTS.yaml`: `http.telegram-connector.public-{dialogs,messages,send}.v1`, marcadores `// CONTRACT:` en el router, trailers `Contract-Change:`; `pnpm contract:check` verde, 73 tools.
- C8 `ARCHITECTURE.md` §2, §4, §6 y §8.
