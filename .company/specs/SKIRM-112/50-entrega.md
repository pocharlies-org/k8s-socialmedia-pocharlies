Rol: developer · Fecha: 2026-10-10 · Sesión: 715ef7e4-8c79-4f49-a12d-59a7c4339ea7 · Estado: LISTO

# SKIRM-112 · Instagram: HMAC en /api/v1/:account/* del conector

Rama `SKIRM-112-hmac` contra `deploy/prod`. Pull request: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/249

## Qué se hizo

- **La puerta**: `connectors/instagram/src/api-gate.ts` (`connectorApiGate`) monta `createHMACAuth` sobre `/api/v1` en `createInstagramApp` (`main.ts`), después de `/health` y del webhook y antes de cualquier ruta de `/api/v1`. El callback del emparejamiento (`/oauth/instagram/callback`) vive fuera de `/api/v1`. Un GET firma `{}`; `x-user-sub` y el almacén de credenciales por usuario no cambian.
- **Falla cerrado sin tumbar el proceso**: con la clave ausente o vacía, o con el valor del repositorio bajo `CONNECTOR_SECRET_STRICT=true`, todo `/api/v1` responde 503 y el arranque deja un `warn`; el webhook y `/health` siguen contestando. Usa `requireConnectorSecret` de `shared` (SKIRM-103).
- **La puerta se mueve a `shared`** (`shared/src/crypto/connector-auth.ts`: `createHMACAuth`, `createHMACRejectLog`) para no copiarla: `whatsapp-web/src/api/auth.ts` la reexporta y `createPublicRouter` usa el mismo registro de rechazos (misma línea `[public-api] rejected …`). `shared` gana `@types/express` como devDependency (import solo de tipos; 3 líneas en el lockfile).
- **Los consumidores firman**: `mcp-server` (`instagramCall`, que cubre las tools de Instagram; `connectorCall` del emparejamiento ya firmaba) y `src/jobs/instagram-backfill.ts` (resuelve la clave al cargar: sin ella no corre, en vez de convertirlo en una sonda fallida). `docker-compose.yml` pasa la clave al servicio `instagram-connector`.
- **Tests**: `connectors/instagram/src/v1-auth.test.ts` (7, en `scripts.test`) y `mcp-server/src/mcp/server.instagram-signing.spec.ts` (6); el conector de mentira de `server.connector-signing.spec.ts` pasa a `mcp/test-connector.ts` y lo usan los dos. `boot-accounts.test.ts` firma sus dos peticiones.
- **Docs**: `ARCHITECTURE.md` §2, §4 y §8; nota de cambio `.company/changes/skirm-112-instagram-api-hmac.md`. Evidencia: `.company/evidence/SKIRM-112.md`.

## Regla de C4

C4 sigue la regla común `requireConnectorSecret` de SKIRM-103 (la spec se reescribió el 10-10 y el architect lo aceptó en `nota-architect-pr249.md`, punto 3): modo aviso salvo `CONNECTOR_SECRET_STRICT=true`. El valor del repositorio avisa y acepta; con el interruptor, y sin clave o con la clave vacía, `/api/v1` responde 503 y el proceso no cae. Así el pin de la imagen no depende del orden de la rotación (SC-2092); con el valor público la puerta no protege hasta que la clave propia esté puesta y el interruptor activado.

## Cómo verificarlo

```sh
pnpm --filter @mcp-socialmedia/instagram-connector test     # 60 pass
pnpm --filter ./connectors/instagram exec tsx --test src/v1-auth.test.ts
pnpm --filter @mcp-socialmedia/server test                   # 703 pass, 8 skipped
pnpm --filter @mcp-socialmedia/connector test                # 593 pass, 1 skipped
pnpm contract:check && python3 scripts/render-connectors.py --check
```

Rojo → verde en `.company/evidence/SKIRM-112.md`. Firma a mano: receta de `ARCHITECTURE.md` §8 con `/api/v1/accounts`.

## Checklist de `00-spec.md`

- [x] C1. Sin firma 401; firmada como hoy; otro cuerpo o fuera de ventana 401; `/health`, `/webhook` y el callback sin la puerta; test con `fetch` sobre `createInstagramApp`, en `scripts.test`.
- [x] C2. La firma de un GET es `HMAC(ts:{})`, con el mismo firmador que usa `mcp-server`.
- [x] C3. `mcp-server` firma todas sus llamadas al conector de Instagram; una llamada firmada a un conector sin la puerta funciona.
- [x] C4. Sin clave, con la clave vacía o con el valor del repositorio bajo `CONNECTOR_SECRET_STRICT=true`: 503 y `warn`, el proceso sigue; con el valor del repositorio sin el interruptor: `warn` y acepta; con clave propia, funciona. Tests «C4: sin clave, con la clave vacía o con el valor del repositorio bajo el interruptor estricto → 503 y aviso; el resto sigue» y «C4: con una clave propia funciona; el valor del repositorio sin el interruptor avisa y arranca» en `connectors/instagram/src/v1-auth.test.ts`.
- [x] C5. `x-user-sub` y el almacén no cambian: `credential-resolution` y `oauth-pairing` sin modificar y en verde.
- [ ] C6. Orden de despliegue: no es de esta PR; `sre` evidencia que no queda un llamante sin firma antes de que el conector exija.
- [ ] C7. Prueba de `qa` tras la rotación SC-2092: no es de esta PR.
- [x] C8. Ninguna entrada existente cambia; `main.ts`, `public-routes.ts` y `server.ts` son superficie de contrato y el checker exige registro y trailer en el mismo push, así que se añade `http.instagram-connector.api-v1.v1` (el id que propone el spec; marcador en `main.ts`, `Contract-Change: add`). El architect puede ajustar su texto; un cambio de la superficie sería un `.v2`. `pnpm contract:check` OK, 73 tools sin cambio.
- [x] C9. `ARCHITECTURE.md` §2, §4 y §8 actualizada. Sin `Co-authored-by` de fork: no se aprovechó código del fork.

## Reutilizado

- `createHMACAuth` y `HMACRejectReason` de `connectors/whatsapp-web/src/api/auth.ts`: movidos tal cual a `shared/src/crypto/connector-auth.ts`; no hay una segunda copia.
- El registro de rechazos de `createPublicRouter` (`connectors/whatsapp-web/src/api/public-routes.ts`): extraído a `createHMACRejectLog` y usado por los dos routers; su test (`public-routes.test.ts`, 13 casos) sigue verde sin modificar.
- `requireConnectorSecret` y `CONNECTOR_SECRET_PLACEHOLDER` (`shared/src/crypto/connector-secret.ts`, SKIRM-103) para decidir si la clave sirve; `generateHMACSignature` y `verifyHMACSignature` (`shared/src/crypto/encryption.ts`) para firmar en `mcp-server` y verificar en sus tests.
- Patrón de tests: `connectors/instagram/src/boot-accounts.test.ts` y `webhook-signature.test.ts` (arrancar `createInstagramApp` y llamar con `fetch`); el barrido de rutas, de `connectors/whatsapp-web/src/api/v1-auth.test.ts`; el conector de mentira, de `mcp-server/src/mcp/server.connector-signing.spec.ts`.
- Buscado: `rg -n "createHMACAuth|requireConnectorSecret|CONNECTOR_SECRET_STRICT"`, `rg -n "instagram-connector|INSTAGRAM_CONNECTOR_URL|:3003"`, `rg -n "instagramUrl|instagramCall|generateHMACSignature" mcp-server/src`, `rg -n "api/v1|createInstagramApp" connectors/instagram/src/*.test.ts` (solo `boot-accounts.test.ts` llama a `/api/v1` por la app).
- Escrito nuevo: `connectorApiGate` (una función de 12 líneas con el 503 que `requireConnectorSecret` no da: allí lanza y el proceso no arranca, y aquí el webhook tiene que seguir vivo); las dos líneas de cabecera de `instagramCall` y de `fetchJson` (el resto de firmantes de `server.ts` ya las llevan en línea); `v1-auth.test.ts`, `server.instagram-signing.spec.ts` y `test-connector.ts`.
- No construido: esquema de autenticación nuevo; `account-access.ts` / `accountAuthorization` del fork (esquema por token de cuenta, otro); un ayudante de firma compartido para los cinco firmantes en línea de `server.ts` (deuda anotada, otro cambio).

## Documento que refleja el cambio

`ARCHITECTURE.md` (§2, §4, §8) y `.company/changes/skirm-112-instagram-api-hmac.md`.

## Riesgo

Un llamante del puerto 3003 que no firme dejará de funcionar cuando el conector se despliegue con esta puerta (de ahí C6). Reiniciar `instagram-connector` y, por el pin, `mcp-server`, `mcp-sse`, los CronJobs de brain y el Job PreSync; `whatsapp-web` cambia de bytes (reexporta la puerta desde `shared`) sin cambiar de comportamiento, y no hace falta reiniciarlo por esto. No se toca ningún manifiesto de `k8s/` ni se activa `CONNECTOR_SECRET_STRICT`.
