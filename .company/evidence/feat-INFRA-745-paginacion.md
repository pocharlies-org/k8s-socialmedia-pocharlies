# Evidencia INFRA-745 — paginacion del barrido de participantes

Rama: `feat/INFRA-745-paginacion` sobre `origin/deploy/prod` (b0a3de0).
Repo: k8s-socialmedia-pocharlies. Ejecutado en el worktree
`.claude/worktrees/INFRA-745-paginacion` con `pnpm install --frozen-lockfile`.

Hallazgo de qa (70-qa.md de INFRA-125, C2 NO CUMPLE): el barrido del bot
sauvage solo auditaba los 200 primeros miembros. Causa: MTProto
(`channels.getParticipants`) devuelve como maximo 200 por llamada y el conector
hacia UNA sola llamada (`getChatMembers`, filtro `recent`, `offset=0`), sin bucle
de paginacion; el bot pedia `?limit=1000` en una sola peticion y el comentario de
`connector-client.ts` («getParticipants pagina internamente») era falso.

## Test que debe fallar primero (rojo contra el codigo actual)

Comando (antes del arreglo):

```
pnpm --filter ./sauvage-verificacion exec tsx --test src/pasada.test.ts
```

Salida (roja, reproduce el hallazgo: total=200 en vez de 346, una sola peticion):

```
TAP version 13
not ok 1 - barrido: recorre TODAS las paginas (200 + 146) y la linea barrido cuadra (C2)
  error: total del barrido  200 !== 346
  expected: 346  actual: 200
not ok 2 - barrido: pide paginas hasta la corta y no una sola peticion de 1000
  error: dos paginas: 200 + 146 (la corta termina el barrido)  1 !== 2
  expected: 2  actual: 1
1..2
# tests 2
# pass 0
# fail 2
```

El test modela la semantica real de Telegram: cada pagina mide como maximo 200 y
`offset` avanza; sin `offset` (la peticion del bot antes del arreglo) solo salen
los 200 primeros.

## Verde despues del arreglo

Bot (33 = los 31 de antes + los 2 nuevos de `pasada.test.ts`):

```
pnpm --filter ./sauvage-verificacion test
# tests 33
# pass 33
# fail 0
```

Conector (ruta de participantes + moderacion, que comparte el `serveConnector`
extraido a `test-harness.ts`):

```
pnpm --filter ./connectors/telegram exec tsx --test src/api/participants-route.test.ts src/api/moderation-routes.test.ts
# tests 11
# pass 11
# fail 0
```

Suite completa del conector telegram (sin regresiones): `# tests 133 / # pass 125 / # fail 0 / # skipped 8`.

Tipos (`tsc`) limpios en `connectors/telegram` y `sauvage-verificacion`.

## Criterio cubierto

- C2 (barrido completo): el barrido recorre las 346 identidades (200 + 146) y la
  linea `barrido total=346 auditados=346 no_auditados=0` cuadra (auditados +
  no_auditados = total, una linea `veredicto ID=` por identidad distinta).
  Afirmado con el test `pasada.test.ts` (con `total` del conector = 346, el
  conteo real, no la longitud de pagina). La re-medida en produccion contra el
  `participant_count` real del grupo la hace qa (ACCION de 70-qa.md).

## Donde cayo el arreglo: conector y bot (la regla, no el caso)

- Conector (`connectors/telegram/src/telegram-client.ts`): `getParticipants` pasa
  `offset` a `getChatMembers`, pide el filtro `all` (con `recent` Telegram se
  topa a 200 sea cual sea el offset) y devuelve `{ participants, total }` con el
  `count` real. Tope por llamada 200 y `offset` negativo a 0.
- Ruta (`connectors/telegram/src/api/controller.ts`): `GET /chats/:id/participants`
  acepta `offset` (adicion compatible) y devuelve `total`. Marcada con la v1
  (intacta) y la nueva `http.telegram-connector.chats-participants.v2` en
  `CONTRACTS.yaml`.
- Bot (`sauvage-verificacion/src/connector-client.ts`): `listarParticipantes`
  itera por paginas de 200 con `offset` hasta una pagina corta, con dedup por id
  y parada si una pagina no aporta ids nuevos (evita bucle infinito contra un
  conector viejo que ignorase `offset`). Se corrigio el comentario erróneo.
- Se revisaron los otros sitios del bot que asumen una sola pagina:
  `moderacion.ts` (`participantes()`, `esParticipante()`) usan el mismo
  `listarParticipantes`, ya paginado. `informe.ts` no recorre participantes.
