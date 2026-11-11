Rol: developer · Fecha: 2026-11-11T14:10:00Z · Sesión: 1230d09c-5382-4747-b306-f21c5edd385f · Estado: LISTO

# 50-entrega — INFRA-745 (reapertura): pagina el barrido de participantes

## Qué se hizo

Arreglo del hallazgo único de qa (70-qa.md de INFRA-125, C2 NO CUMPLE): el barrido del bot sauvage solo auditaba los 200 primeros miembros del grupo.

Causa: MTProto (`channels.getParticipants`) devuelve como máximo 200 participantes por llamada; el conector hacía UNA sola llamada a `getChatMembers` (filtro `recent`, `offset=0`) sin bucle y descartaba el `count` real. El bot pedía `?limit=1000` en una sola petición y el comentario de `connector-client.ts` («getParticipants pagina internamente») era falso. Con el grupo en ~346, ~146 miembros llevaban sin auditar desde el despliegue.

Cambios (la regla, no el caso):

- `connectors/telegram/src/telegram-client.ts` — `getParticipants(chatId, limit, offset)`: pasa `offset` a `getChatMembers`, pide el filtro `all` (con `recent` Telegram se topa a 200 sea cual sea el offset) y devuelve `{ participants, total }` con el `count` real de Telegram. Tope por llamada 200, `offset` negativo a 0.
- `connectors/telegram/src/api/controller.ts` — `GET /chats/:id/participants` acepta `offset` (adición compatible) y devuelve `total`. Marcada con la v1 intacta y la nueva `http.telegram-connector.chats-participants.v2` en `CONTRACTS.yaml` (commit con trailer `Contract-Change: add http.telegram-connector.chats-participants.v2`). Los consumidores v1 (dgx-messages, `social_list_participants` del mcp-server) reciben el mismo `participants` de siempre.
- `sauvage-verificacion/src/connector-client.ts` — `listarParticipantes` itera por páginas de 200 con `offset` hasta una página corta, dedup por id y parada si una página no aporta ids nuevos (evita bucle infinito contra un conector viejo que ignorase `offset`). Corregido el comentario erróneo.
- `sauvage-verificacion/src/pasada.test.ts` (nuevo) — el test que debía fallar primero: cliente falso con 2 páginas (200 + 146) que modela el tope real de Telegram; afirma que el barrido recorre las 346 identidades y que `barrido total=346 auditados=... no_auditados=...` cuadra.
- `connectors/telegram/src/api/participants-route.test.ts` (nuevo) — `offset` llega al cliente, `total` es el count real, filtro `all`, y sin `offset` la v1 responde igual.
- `connectors/telegram/src/test-harness.ts` — `serveConnector`/`connectorFixture` compartidos (el detector de copia pedía reutilizar el caldero de serve, no clonarlo); `moderation-routes.test.ts` actualizado para usarlos.

Otros sitios del bot que asumían una sola página: `moderacion.ts` (`participantes()` y `esParticipante()`) reutilizan el mismo `listarParticipantes`, ya paginado; `informe.ts` no recorre participantes (lee del almacén).

## PR

https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/484 — rama `feat/INFRA-745-paginacion`, base `deploy/prod`, lista para el juez. NO fusionada (la fusión es del flujo de aprobación).

## Cómo verificar

- Rojo antes del arreglo (dejado en `.company/evidence/feat-INFRA-745-paginacion.md`): `pnpm --filter ./sauvage-verificacion exec tsx --test src/pasada.test.ts` → `total del barrido 200 !== 346`, `1 !== 2` peticiones, `# pass 0 / # fail 2`.
- Verde después: `pnpm --filter ./sauvage-verificacion test` → `# pass 33 / # fail 0` (los 31 de antes + 2 nuevos). `pnpm --filter ./connectors/telegram test` → `# pass 125 / # fail 0 / # skipped 8`. `tsc` limpio en ambos paquetes. `company-duplicados --base origin/deploy/prod` → sin duplicación nueva.
- En producción (tras el despliegue, le toca a qa): `barrido total=<participant_count real>` en el stdout del job, `auditados + no_auditados = total`, y las líneas `veredicto ID=` igual al total. La ACCIÓN de 70-qa.md (leer el `participant_count` real con `social_get_group`) sigue pendiente para fijar el total contra el que se re-mide C2.

## Checklist 00-spec.md

- [x] C2 — Barrido completo: arreglado en esta PR y afirmado por `pasada.test.ts` (total=346, la línea del log cuadra, una línea `veredicto ID=` por identidad). La re-medida en producción contra el `participant_count` real la hace qa tras el despliegue.
- [x] C1 — Cadencia: ya cumplida y medida por qa (70-qa.md: CUMPLE); esta PR no toca el planificador.
- [x] C5 — Informe diario: ya cumplida y medida por qa (CUMPLE); el total del informe sale del barrido ya paginado.
- [x] C6 — Persistencia: ya cumplida y medida por qa (CUMPLE); esta PR no toca el almacén.
- [x] C8 — GitOps y doc: ya cumplida y medida por qa (CUMPLE); el arreglo entra por GitOps al entrar esta PR en `deploy/prod`.
- C3/C4/C7: pendientes de activación por diseño (moderación off), fuera de esta reapertura.

## Reutilizado

- `sauvage-verificacion/src/pasada.ts` (`ejecutarPasada`, las formas de log exigidas por C2) y `estado.ts` (`EstadoDb`, `auditadosHoy`, `guardarVeredicto`): el test nuevo ejercita la pasada real con un `EstadoDb` falso, sin duplicar lógica.
- `connectors/telegram/src/test-harness.ts` (`wrapperWith`): el test de la ruta usa el wrapper REAL sobre mtcute falso, el patrón de `moderation-routes.test.ts`; el caldero de `serve`/`afterEach` se subió al harness (`serveConnector`/`connectorFixture`) en vez de clonarse.
- `@mtcute/core` 0.29.7 `getChatMembers` (lee su fuente en `node_modules/.pnpm/.../get-chat-members.js` y `iter-chat-members.js`): confirma el tope de 200 por llamada, el `offset` y el `total` (`res.count`); el filtro `all` es `channelParticipantsSearch` con q vacía.
- `generateHMACSignature` de `@mcp-socialmedia/shared` para la firma GET del test.
- Buscado con: `rg -n "participants" connectors/telegram/src/api/controller.ts`, `rg -n "chats-participants" CONTRACTS.yaml`, `rg -n "listarParticipantes|participants" sauvage-verificacion/src`, `rg -n "getParticipants" connectors/telegram/src`, `rg -n "participants" mcp-server/src/mcp/server.ts` (consumidor v1 verificado: solo lee `participants`).
- Escrito nuevo y por qué: el bucle de páginas del bot y el test de la pasada (nada en el repo paginaba participantes — la ruta no tenía `offset` y el comentario decía falsamente que el conector ya paginaba); la entrada de contrato v2 porque la v1 declara su forma 200 como contract y la adición de `total` se registra como entrada nueva junto a la intacta.

## Notas

- El bloque Rescate de la historia sigue apuntando a la sesión raíz correcta (1230d09c-…) con el agente del run anterior (agent-adea8a03d8f5abf9e); en esta sesión no hay herramienta de edición de descripción disponible, así que no se reescribió. El agente de este run es agent-adacb97e5c263cde7 (subagents/workflows/wf_82008903-303).
- Doc: `docs/sauvage-verificacion.md` describe la pasada y el informe, no la paginación interna; ningún doc necesitaba cambio (la superficie HTTP nueva está en CONTRACTS.yaml).
