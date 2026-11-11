# SKIRM-105 · evidencia (conector WhatsApp: estado de chat al leer, identidad en la respuesta a un evento)

Donde corrió: worktree de la rama `SKIRM-105-f4b`, `connectors/whatsapp-web`, Node 22, sin base de datos en las pruebas (pool de `pg` sustituido), base `7c3103c` (`origin/deploy/prod`, F4a incluida).

## Rojo contra el tronco, mismas pruebas

```
tsx --test src/chat-state.test.ts     # tests 22, pass 19, fail 3
  not ok 15 - chats.upsert archive / unread: canonical row; a chat with no conversation writes nothing
      actual: UPDATE conversations SET unread_count = $2, archived = $3 ... params ['professional:34611@c.us', 0, true]
  not ok 16 - one chat event resolves the canonical conversation once and writes archive, unread, pin and mute there
      expected: 1   actual: 2
  not ok 17 - markAsRead clears the badge on the canonical conversation, never on the jid's own tombstone
      expected: 'professional:111@lid'   actual: 'professional:34600@c.us'
tsx --test src/polls-events.test.ts   # tests 25, pass 23, fail 2
  not ok 15 - our event response when we are only known as a LID: signed with the phone number Baileys maps it to
      Unsupported state or unable to authenticate data   (firmada con un LID)
  not ok 16 - our event response with no phone number of our own: refused before the claim and before WhatsApp
      beforeSend (la reclamación de la Idempotency-Key) se llamó y la respuesta se retransmitió
```

## Verde tras el cambio

```
tsx --test src/chat-state.test.ts      # tests 22, pass 22, fail 0
tsx --test src/durable-paths.test.ts   # tests 14, pass 14, fail 0
tsx --test src/polls-events.test.ts    # tests 25, pass 25, fail 0
pnpm --filter @mcp-socialmedia/connector test (lista explícita de package.json)
                                       # tests 577, pass 576, fail 0, skipped 1 (ninguno de los inestables cayó)
pnpm contract:check                    # Socialmedia contract OK (73 tools)
python3 scripts/render-connectors.py --check   # exit 0
tsc --noEmit (connectors/whatsapp-web) # exit 0
eslint (pnpm run lint)                 # 0 errores
check-contracts.py --range origin/deploy/prod..HEAD  # contracts: OK (101 entries)
company-duplicados --base origin/deploy/prod           # sin duplicación nueva
```

## Criterios de la spec

- C1: cuadro del paso 0 (abajo).
- C2: dos pruebas de comportamiento rojas sobre el tronco y verdes tras el cambio (`polls-events.test.ts` 15 y 16, hueco H-evento) y las de la parte 0 (`chat-state.test.ts` 15–17). Los tests nuevos están en ficheros que ya están en `scripts.test`; las pruebas HTTP arrancan la app con `fetch`, sin `supertest`.
- C3: el fixture del fork (votante `123456789@lid` con su número en `participantAlt`) pasa sobre el tronco: una fila bajo el LID y el voto posterior la reemplaza (`voted_at >=`). Es prueba de caracterización (verde antes y después). El caso «el mismo votante una vez por número y otra por LID» lo pliega la base con el alias (013); no lo prueba ningún test del fork y no se midió con PostgreSQL real (una base vacía no admite la migración 008; eso trae el sandbox de SKIRM-89). En el conector, un voto con la clave dirigida por número y otro por LID se archivan con dos ids de votante distintos hasta que el alias exista.
- C4: las cuatro rutas con la misma `Idempotency-Key`: un solo envío, 200 con `deduplicated`, 409 `idempotency_key_reused` con otro cuerpo, 409 `send_outcome_uncertain` sin reenvío tras una salida perdida (`polls-events.test.ts`, pool simulado). Además una pasada puntual contra un PostgreSQL desechable con la tabla de la migración 010 (`whatsapp_send_attempts`, el resto del esquema sustituido por dos stubs): las cuatro rutas igual, 4 filas `sent` y 4 `pending`, sin tocar el código. No se probó la parte 013 con PostgreSQL real.
- C5 y C6: sin clave, y con `sendToken` constante, las cuatro rutas envían cada vez, sin 409 ni consultas a la tabla; con claves distintas cada petición envía lo suyo (`polls-events.test.ts`, verdes sobre el tronco).
- C7: ninguna tool cambia. `CONTRACTS.yaml`: solo el texto de la nota de `messages-event-respond.v1` (misma clase de fallo, `Contract-Change: migrate`).
- C8: suite verde; `ARCHITECTURE.md` actualizada; trailers en «Autoría adoptada».

## Cuadro del paso 0 (copia de 50-entrega.md)

Los tests del fork (PR #74, cabeza `a5ffeac`; la spec cita `7b81bd24`, que ya no es antecesora: entre ambas solo cambian `poll-votes.ts` y `poll-votes.fork.test.ts`, que añaden `voters` al resultado del fork) se copiaron sin su código y se ejecutaron de uno en uno con `tsx --test <fichero>` contra el tronco, con `DATABASE_URL` y `CONNECTOR_SHARED_SECRET` de prueba como hace el script `test` del fork. Clases: (a) falla una aserción sobre un módulo que el tronco ya tiene · (b) falla porque el módulo, el DDL o la ruta del fork no existen · (c) depende de una ruta, alias o modelo excluido · pasa.

| test del fork (nº de tests) | resultado contra el tronco | clase | equivalente en el tronco / decisión |
|---|---|---|---|
| `poll-votes.fork` (16) | falla al cargar: `ERR_MODULE_NOT_FOUND ./whatsapp-capabilities`; su API (`aggregateCapturedPollVotes`, `decryptCapturedPollVotes`…) tampoco existe | (b) | Aserciones con equivalente, ejecutadas adaptadas: cifrado y lectura de nuestro voto, multiopción, creación V1/V3/V5, secreto de 32 bytes, votante LID descifrado con su identidad, secreto equivocado no cuenta, voto envuelto en efímero, reclamar el id antes de retransmitir con el almacén caído: pasan (cambia el texto de dos errores de validación; el secreto anidado en `pollCreationMessageV3` no existe en el proto). «Último voto gana»: SQL de 013. Fixture de C3: pasa. No entra código |
| `send-idempotency.fork` (3) | falla: `claimReservedSend` no se exporta | (c) | Modelo `sendToken`, que `CLAUDE.md` prohíbe; los casos de `viewOnce` son de medios |
| `event-responses` (10) | falla: `aggregateEventResponses` no se exporta | (b) | El tronco descifra al ingerir y guarda una fila por persona (013); el cifrado de la respuesta legible por Baileys ya está en `poll-votes.test.ts`; `isEventResponse` es estricto (`===`) |
| `event-results` (3) | falla: `ERR_MODULE_NOT_FOUND ./event-results` | (b) | El tronco lee `whatsapp_event_responses_current` en una consulta (sin paginar); `getEventResults` ya existe |
| `event-send` (4) | falla: `ERR_MODULE_NOT_FOUND ./event-send` | (c) | Reserva por `sendToken` |
| `event-client` (4) | falla: `ERR_MODULE_NOT_FOUND ./whatsapp-capabilities` | **(a)** | Adaptado a `respondToEvent`: 2 pasan (reclamar antes de retransmitir, almacenamiento caído no falla la respuesta, RSVP entrante sin fila de chat ni vista previa), **2 fallaban**: cuando solo se conoce el LID propio la respuesta salía firmada con un LID y gastaba la clave (H-evento). Cierre en esta PR; adaptadas pasan 4/4 |
| `controller-event-results` (1) | falla: 400 en lugar de 200 | (c) | Cuerpo `{eventMessageIds[]}` del fork frente al `messages-event-results.v1` del tronco (`messageId`); sin llamador |
| `event-responses.postgres.mjs` (1 script) | no corre: necesita `listCapturedEventResponses` y una base de pruebas | (b) | Pagina respuestas capturadas del fork |
| `gif-send` (2) | falla: 200 en lugar de 400 y `mimetype` ausente | fuera del área | Medios (`/messages/media/send`, `sendFile`). No entra |
| `media-send` (14) | 5 pasan, 9 fallan | fuera del área | Medios: GIF crudo, vista única en sticker/audio/documento, calidad de WebP con alfa, bloqueo de persistencia de medios, medios de canal; 2 caen por el fixture (`logger`, `size`). No son votos, eventos ni idempotencia; candidatos a una historia de medios. No entra |

Hueco real, H-evento: `ownIdentity().pn` caía a `cryptoUserJid(meJid)` y podía ser un LID. Con solo un LID propio conocido, `respondToEvent` firmaba con un LID (WhatsApp descifra con números), retransmitía y gastaba la `Idempotency-Key`. Cierre: `ownIdentity` separa PN y LID y `respondToEvent` resuelve el número propio por la correspondencia LID a número de Baileys; sin número, 422 `identity_unavailable` antes de reclamar. Hipótesis no medida: que una cuenta real llegue a ese estado (`sock.user` ausente o con LID); el fixture del fork lo prueba y el arreglo no cambia el caso habitual (`sock.user` con número).

## Autoría adoptada

Ningún commit copia código del fork: las pruebas de `polls-events.test.ts` adaptan **escenarios** y valores de fixture de `event-client.test.ts` y `poll-votes.fork.test.ts` de la PR #74 (Jordi Ibáñez), reescritos sobre la API del tronco.

| commit | qué adopta del fork | trailer en el commit |
|---|---|---|
| `53cba88` | las pruebas de identidad propia en la respuesta a un evento y el fixture del votante LID (escenarios, no código) | ninguno: se subió antes de anotar la adopción y la rama no se reescribe |
| `d7a5e54` | deja el origen en el comentario de cada prueba | `Co-authored-by: Jordi Ibáñez <staticduo@gmail.com>` |
| el commit de esta evidencia y de la nota del contrato | documenta la adopción | `Co-authored-by: Jordi Ibáñez <staticduo@gmail.com>` |

`b1907cf` (parte 0, `markAsRead`) y el commit de refactor (`rememberChatSnapshot` y la tabla de intentos simulada compartida) son trabajo propio: no adoptan nada del fork.
