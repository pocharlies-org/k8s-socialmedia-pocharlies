# SKIRM-106 · evidencia, PR 2 de F4c (conector WhatsApp: memoria de los canales que sigue la cuenta)

Donde corrió: worktree de la rama `SKIRM-106-f4c2`, `connectors/whatsapp-web` y `mcp-server`, Node 22. Las pruebas de la PR no usan base de datos (pool de `pg` sustituido). La migración y la prueba de comportamiento corrieron en una base desechable con el esquema del tronco (`scripts/qa-schema-sandbox.sh up`, de SKIRM-89, volcado solo de esquema, con tres filas de `social_accounts` sembradas a mano). Base `0daf959` (`origin/deploy/prod`, SKIRM-89 incluida), con el tronco `fc402ef` (la PR 245 ya fusionada) incorporado a la rama.

Esta PR cubre B1 a B10 de la nota del architect (criterios C3, C4 y C5 de la spec).

## La tumba en memoria de un borrado anticipado (B5 a B9) y el payload de un id compuesto (B10)

Comprobación de que cada regla importa: con la regla desactivada, sobre el mismo árbol, fallan las pruebas nuevas de `statuses.test.ts` (15 a 20).

```
sin noteRevokeBeforePost en handleInboundMutation y sin la guarda de B10   # pass 20, fail 5
  not ok 15 - a revoke that finds no post is remembered: the post is stored and marked deleted when it arrives
  not ok 16 - a revoke that found its row remembers nothing; a remembered one is used up once
  not ok 17 - the same id in another channel is not marked; a chat that is neither a channel nor a status remembers nothing
  not ok 18 - channel A holds the bare id: the revoke of channel B finds no row, and B post (composed) is marked, not A
  not ok 20 - a channel post under a composed id does not touch the first channel payload; one with its bare id still writes it
con la clave de la tumba sin el chat (solo el id)                          # pass 23, fail 2
  not ok 17 y not ok 19 (el mismo id en otro canal se marcaría)
con el código de la rama                                                    # tests 25, pass 25, fail 0
```

- B5: `noteRevokeBeforePost(chatJid, id)` y `takeRevokeBeforePost(chatJid, id)` en `statuses.ts`, junto a `channelPostMessageId`; un `Map` de módulo con clave `chat|id` tal como llega (antes de componer, sin prefijo de cuenta), como mucho 2000 (sale la más antigua) y 24 h comprobadas al consultar; `take` la consume (prueba 19).
- B6: `handleInboundMutation` anota solo si el chat es un canal o un estado y el revoke no encontró fila; `recordInboundRevoke` devuelve el booleano de `markMessageRevoked`.
- B7: `ingestMessage` la consume justo después de `storeMessage`, solo para esos dos tipos de chat y solo si el post se guardó (con un fallo de la base la anotación se conserva): marca la fila (la compuesta si la hubo) con `recordInboundRevoke`, que emite `message-update DELETED` como un borrado normal.
- B8: dos líneas `info` sin contenido del mensaje: «found no post: remembered» y «arrived before its post: applied».
- B9: pruebas 15 a 20: canal y estado; un revoke que sí encontró fila no anota; la tumba se consume una vez; caduca a las 24 h (reloj simulado; 24 h exactas aún cuenta) y se acota a 2000; el mismo id en otro canal no se marca; el caso mixto (el canal A tiene el id desnudo, el revoke de B no encuentra fila, el post de B, compuesto, queda borrado sin tocar la fila de A). `ARCHITECTURE.md` §8 dice el límite tal cual: no sobrevive a un reinicio y cubre la carrera dentro de un proceso.
- B10: `ingestMessage` no llama a `persistDurablePayload` cuando `waMessage.waMessageId` difiere de `msg.key.id`; la prueba 20 cuenta los `INSERT INTO whatsapp_message_payloads` (0 con choque, 1 sin él o con el titular del propio canal).

## La migración sobre el esquema del tronco

```
scripts/qa-schema-sandbox.sh up                 # Running migration 021_whatsapp_novedades_channels.sql...  (tablas en public 40, filas en _migrations 21)
scripts/qa-schema-sandbox.sh up (otra vez)      # Skipping 021_whatsapp_novedades_channels.sql (recorded in _migrations)
psql -f 021_… (dos veces a mano, ON_ERROR_STOP)  # exit 0 y 0, «relation … already exists, skipping»
borrar la fila 021 del ledger y volver a correr  # Baselining 021_whatsapp_novedades_channels.sql: table "whatsapp_novedades_channels" predates the ledger
```

La tabla queda con `account`, `account_id`, `channel_jid`, `created_at`, la clave primaria como único índice y el trigger `trg_social_whatsapp_channel_account`.

## Rojo contra el tronco, verde tras el cambio

Un canal seguido, sin posts, consultado por un proceso que luego se reinicia (cuenta `professional`, base con el esquema del tronco):

```
código del tronco:  sameProcess   → ["999999@newsletter", …]      afterRestart → sin "999999@newsletter"
rama + migración:   sameProcess   → ["999999@newsletter"]
                    row           → {account: professional, account_id: whatsapp:professional, channel_jid: 999999@newsletter}
                    afterRestart  → ["999999@newsletter"]
                    afterUnfollow → []      filas tras dejar de seguirlo → 0
```

Pruebas de unidad nuevas en `communities-channels.test.ts` (ya en `scripts.test`):

```
tsx --test src/communities-channels.test.ts        # tests 26, pass 26, fail 0
con rememberChannel desactivado (comprobación):    # pass 24, fail 2
  not ok 20 - followed list: a followed channel with no post survives a restart; one no longer followed is forgotten
  not ok 22 - followed list: three accounts share the table and never see each other
```

Las cuatro pruebas nuevas: alta, baja y la lista tras un reinicio; una fila que WhatsApp no confirma no se lista y se olvida; tres cuentas (personal, professional, leila) comparten la tabla y cada una lee y escribe solo lo suyo; tabla ausente (`42P01`): un aviso, ninguna consulta repetida mientras se sabe que falta y otra al acabar la espera.

## Verde

```
pnpm run test (whatsapp-web, lista explícita)   # tests 592, pass 591, fail 0, skipped 1 (ninguno de los inestables cayó)
jest src/infrastructure/database/migrate.spec.ts   # 5 pasan (el libro de migraciones incluye la 021 y la ejecuta la última)
tsc --noEmit (connectors/whatsapp-web)          # exit 0
eslint src --ext .ts                            # 0 errores
pnpm contract:check                             # Socialmedia contract OK (73 tools)
python3 scripts/render-connectors.py --check    # exit 0
```

## Criterios de la nota del architect

- B1: `021_whatsapp_novedades_channels.sql` (la 020 era la última): `CREATE TABLE IF NOT EXISTS`, PK `(account, channel_jid)`, `account_id` por trigger como la 019, sin índices, sin DDL sobre tablas existentes, sin backfill, sin cifras de producción en la cabecera.
- B2: `listChannels` suma como candidatos las filas de su cuenta (`WHERE account = connectorAccount()`, tope `CHANNELS_LIST_MAX`); alta donde se recuerda un canal seguido (`lookupChannel`, `setChannelSubscription`) y baja al confirmar que ya no se sigue, solo con `ingest`; solo se borra una fila que existe; `seenChannels` se queda; `42P01` tolerado.
- B3: pruebas de unidad, tres cuentas y la migración sobre el esquema del tronco (arriba).
- B5 a B10: arriba. B4: `ARCHITECTURE.md` §4 y §8, `MCP.md` y la nota de `http.whatsapp-connector.channels-list.v1` con `Contract-Change: migrate http.whatsapp-connector.channels-list.v1`. La migración viaja en la imagen de `mcp-server` (Job PreSync): hace falta su pin, que no es de esta PR.

## Autoría adoptada

Ningún commit copia código del fork. Se adopta la idea de un directorio persistido de canales seguidos (`whatsapp_novedades_channels`) de la PR #74 (Jordi Ibáñez); el DDL y el código son nuevos, sobre la API del tronco, sin `ensureNovedadesTables` ni rutas `/novedades/*`.

| commit | qué adopta del fork | trailer en el commit |
|---|---|---|
| el commit del cambio (migración 021, directorio en `channels.ts`, pruebas y documentos) | la idea de la tabla del directorio | `Co-authored-by: Jordi Ibáñez <staticduo@gmail.com>` |
| el commit de la tumba en memoria y B10 (`statuses.ts`, `baileys-client.ts`, pruebas, documentos y esta evidencia) | el principio de `NOVEDADES-STORE.md` de que un borrado anterior al post no se resucita; aquí en memoria y sin tabla, no la tumba durable del fork | `Co-authored-by: Jordi Ibáñez <staticduo@gmail.com>` |
| el commit de esta evidencia (primera parte) | documenta la adopción | `Co-authored-by: Jordi Ibáñez <staticduo@gmail.com>` |
