# SKIRM-106 · evidencia (conector WhatsApp: identidad de un post de canal, F4c)

Donde corrió: worktree de la rama `SKIRM-106-f4c`, `connectors/whatsapp-web`, Node 22. Las pruebas de la PR no usan base de datos (pool de `pg` sustituido). Las pruebas de comportamiento del paso 0 corrieron además contra una base desechable con el esquema del tronco (sandbox de SKIRM-89, `scripts/qa-schema-sandbox.sh up`). Base `ab99822` (`origin/deploy/prod`, F4a y F4b incluidas).

## Rojo contra el tronco, mismas pruebas

```
tsx --test src/statuses.test.ts   # tests 19, pass 16, fail 3
  not ok 10 - a channel post whose id another channel holds is stored under <channel>:<id>, not dropped
      expected: 'professional:222@newsletter:SAME'   actual: 'professional:SAME'
  not ok 12 - a clash on the personal account composes the id without a prefix; chats pay no lookup
      expected: '222@newsletter:SAME'   actual: 'SAME'
  not ok 14 - a revoke or an edit of a channel post reaches the row of ITS channel, not the other one
      expected: 'professional:222@newsletter:SAME'   actual: 'professional:SAME'
```

Con el id en la misma clave, `INSERT INTO messages ... ON CONFLICT (wa_message_id) DO NOTHING` descarta el segundo post sin dejar rastro.

## Verde tras el cambio

```
tsx --test src/statuses.test.ts        # tests 19, pass 19, fail 0 (los otros 2 tests nuevos pasan antes y después: caracterizan «sin choque, id desnudo»)
pnpm run test (whatsapp-web, lista explícita)   # tests 582, pass 581, fail 0, skipped 1 (ninguno de los inestables cayó)
pnpm contract:check                    # Socialmedia contract OK (73 tools)
python3 scripts/render-connectors.py --check   # exit 0
tsc --noEmit (connectors/whatsapp-web) # exit 0
eslint src --ext .ts                   # 0 errores
check-contracts.py --range origin/deploy/prod..HEAD  # contracts: OK (101 entries)
```

## Prueba de comportamiento sobre el esquema del tronco (base desechable)

Mismo escenario con el código del tronco y con el de la rama, cuenta `professional`, dos canales y un mismo id `SAME`:

| | tronco | rama |
|---|---|---|
| filas de `messages` con ese id | 1 (el del canal 111; el post del canal 222 no existe) | 2 (`professional:SAME` y `professional:222@newsletter:SAME`) |
| `whatsapp_message_keys` del id del canal 111 | apunta al canal 222 (la clave del post descartado la reescribe) | cada fila apunta a su canal |
| `social_list_channel_posts` del canal 222 | 0 posts | 1 post |
| revoke del post del canal 222 | marca borrado el del canal 111 | marca borrado solo el del canal 222 |

## Criterios de la spec

- C1: cuadro del paso 0 (abajo) con las tres pruebas propias.
- C2: pruebas 10, 12 y 14 de `statuses.test.ts`, rojas sobre el tronco y verdes tras el cambio; el escenario sobre el esquema del tronco (tabla de arriba).
- C3, C4 y C5: **no están en esta PR**. Las pruebas propias P2 y P3 del cuadro fallan sobre el tronco y su arreglo pide una tabla nueva (migración `021_…`, aditiva), que no se escribe aquí: depende del sandbox de SKIRM-89 fusionado. Quedan para la siguiente PR de la historia.
- C6: las pruebas 1 a 9 de `statuses.test.ts` (ingest del estado, lectura por autor, índice ausente `42P01`, lectura de posts de canal) pasan antes y después sin tocarlas; las pruebas 11 y 13 (id desnudo sin choque o con consulta fallida) también.
- C7: ninguna tool cambia; suite de whatsapp-web verde; `ARCHITECTURE.md` §8 actualizada (§4 no cambia: esta PR no añade tabla); sin cambio de `CONTRACTS.yaml` (`http.whatsapp-connector.channels-posts.v1` mantiene ruta, cuerpo y forma del 200; el `messageId` de un post con choque es la cadena compuesta); trailers en «Autoría adoptada».

## Cuadro del paso 0 (copia de 50-entrega.md)

Los tests del fork (PR #74, cabeza `a5ffeac`), copiados sin su código y ejecutados de uno en uno con `tsx --test` sobre el tronco. Clases: **(a)** la aserción falla sobre un módulo que el tronco ya tiene (`statuses.ts`); **(b)** falla porque el módulo, el DDL o la ruta del fork no existen en el tronco; **(c)** depende de una ruta excluida (`/novedades/*`).

| test del fork (nº de tests) | resultado contra el tronco | clase | equivalente en el tronco / decisión |
|---|---|---|---|
| `novedades-store.test.ts` | falla al cargar: `ERR_MODULE_NOT_FOUND ./novedades-store` | (b) | El almacén aislado del fork (`whatsapp_novedades_*` y `ensureNovedadesTables`) no existe; su DDL está excluido. Lo equivalente es `statuses.ts` y la migración 019 |
| `novedades-channels.test.ts` | falla al cargar: `./novedades-channels` | (b) | `channels.ts` y los métodos de canal de `baileys-client.ts` |
| `novedades-ingest.test.ts` | falla al cargar: `./novedades-ingest` | (b) | La ingesta de canales y estados está en `ingestMessage` y `recordStatus` |
| `novedades-reader.test.ts` | falla al cargar: `./novedades-reader` | (b) | `listChannelPosts` y `listStatuses` de `statuses.ts` |
| `novedades-controller.test.ts` | falla al cargar: `./novedades-communities` | (c) | Rutas `/novedades/*` y `novedades-communities.ts` excluidas |
| `novedades-status-send.test.ts` | falla: `baileys-client.js` no exporta `NOVEDADES_STATUS_MEDIA_MAX_BYTES` | (b) | `publishNovedadesStatus` no existe; el tronco publica estados de texto e imagen por URL (`statuses/publish`) |
| `controller-novedades-status.test.ts` | falla: mismo export | (c) | Ruta `/novedades/status` excluida |
| `statuses.test.ts` del fork (17) | 13 pasan, 4 fallan | pasa ×13 | Ingest del estado, lectura por autor (PN y LID), índice ausente (`42P01`), publicación |
| ↳ prueba 5, «not indexed…» | espera `INSERT INTO whatsapp_novedades_messages` | (b) | Tabla aislada del fork |
| ↳ pruebas 10 y 11, «channel feed merges / filters tombstones» | esperan lecturas de `whatsapp_novedades_messages` | (b) | Tabla aislada del fork |
| ↳ prueba 9, «channel posts: channels from conversations…» | falla solo la regex `ORDER BY … wa_message_id COLLATE "C" DESC` | (a), descartada | Sin diferencia de comportamiento: con esa regex relajada pasan todas las demás aserciones; el cursor compara `(wa_timestamp, wa_message_id)` con la misma colación del `ORDER BY`. El fork necesita `C` porque une dos fuentes en JavaScript. No se adopta |
| `statuses.postgres.mjs` (1 script) | `ENOENT ../migrations/002_novedades_persistence.sql` | (b) | Crea su esquema con el DDL del fork, excluido |

Pruebas de comportamiento propias, contra el código del tronco y el esquema del tronco (las dos que pedía la spec y una tercera por el directorio):

| prueba propia | contra el tronco | clase | decisión |
|---|---|---|---|
| P1. Dos posts de canales distintos con el mismo id | el segundo se descarta; la clave del primero pasa a apuntar al otro canal; el canal 222 lista 0 posts | **(a)**, importa | Arreglado en esta PR (`channelPostMessageId`): sin migración, sin tocar filas existentes |
| P2. Un borrado llega antes del post (post de canal y estado) | el post y el estado aparecen visibles: `markMessageRevoked` es un `UPDATE` sin fila que no deja rastro | **(a)**, importa | Una tumba que sobreviva a un reinicio pide tabla (`021_…`): **bloqueado** hasta SKIRM-89 |
| P3. Un canal seguido y sin posts, tras reiniciar | desaparece de `social_list_channels`: `seenChannels` es memoria del proceso y `knownChannelConversations` solo ve canales con conversación | **(a)**, importa | El directorio persistido pide la tabla `whatsapp_novedades_channels`: **bloqueado** hasta SKIRM-89 |

Lo que importa de verdad en la frecuencia está sin medir aquí: P1 demuestra el mecanismo (clave única por cuenta con `ON CONFLICT DO NOTHING`), no cuántos ids se repiten entre canales en el uso real.

## Autoría adoptada

Ningún commit copia código del fork. Se adopta el principio que describe `NOVEDADES-STORE.md` de la PR #74 (Jordi Ibáñez): los ids de un canal solo son únicos dentro de ese canal, así que la identidad de un post se lee por canal. Las pruebas de la PR son propias, sobre el esquema y la API del tronco.

| commit | qué adopta del fork | trailer en el commit |
|---|---|---|
| el commit del cambio (`channelPostMessageId`, sus pruebas y `ARCHITECTURE.md`) | el principio de identidad por canal | `Co-authored-by: Jordi Ibáñez <staticduo@gmail.com>` |
| el commit de esta evidencia | documenta la adopción | `Co-authored-by: Jordi Ibáñez <staticduo@gmail.com>` |

Lo que no se adopta: `novedades-*.ts`, `ensureNovedadesTables`, las 13 rutas `/novedades/*`, `novedades-communities.ts` y el DDL del fork.
