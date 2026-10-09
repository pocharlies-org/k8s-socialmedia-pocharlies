# SKIRM-106 · evidencia, PR 2 de F4c (conector WhatsApp: memoria de los canales que sigue la cuenta)

Donde corrió: worktree de la rama `SKIRM-106-f4c2`, `connectors/whatsapp-web` y `mcp-server`, Node 22. Las pruebas de la PR no usan base de datos (pool de `pg` sustituido). La migración y la prueba de comportamiento corrieron en una base desechable con el esquema del tronco (`scripts/qa-schema-sandbox.sh up`, de SKIRM-89, volcado solo de esquema, con tres filas de `social_accounts` sembradas a mano). Base `0daf959` (`origin/deploy/prod`, SKIRM-89 incluida).

Esta PR cubre B1 a B4 de la nota del architect (criterios C3 y C4 de la spec). La tumba en memoria de un borrado anticipado y la condición sobre `whatsapp_message_payloads` (B5 a B10) se apoyan en `channelPostMessageId` de la PR 245 y van cuando esa PR esté fusionada.

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
pnpm run test (whatsapp-web, lista explícita)   # tests 581, pass 580, fail 0, skipped 1 (ninguno de los inestables cayó)
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
- B4: `ARCHITECTURE.md` §4 y §8, `MCP.md` y la nota de `http.whatsapp-connector.channels-list.v1` con `Contract-Change: migrate http.whatsapp-connector.channels-list.v1`. La migración viaja en la imagen de `mcp-server` (Job PreSync): hace falta su pin, que no es de esta PR.

## Autoría adoptada

Ningún commit copia código del fork. Se adopta la idea de un directorio persistido de canales seguidos (`whatsapp_novedades_channels`) de la PR #74 (Jordi Ibáñez); el DDL y el código son nuevos, sobre la API del tronco, sin `ensureNovedadesTables` ni rutas `/novedades/*`.

| commit | qué adopta del fork | trailer en el commit |
|---|---|---|
| el commit del cambio (migración 021, directorio en `channels.ts`, pruebas y documentos) | la idea de la tabla del directorio | `Co-authored-by: Jordi Ibáñez <staticduo@gmail.com>` |
| el commit de esta evidencia | documenta la adopción | `Co-authored-by: Jordi Ibáñez <staticduo@gmail.com>` |
