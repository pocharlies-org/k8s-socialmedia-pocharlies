# SKIRM-104 · evidencia (conector WhatsApp: estado de archivo y fijado)

Donde corrió: worktree de la rama `SKIRM-104-f4a`, `connectors/whatsapp-web`, Node 22, sin base de datos (pool de `pg` sustituido en las pruebas).

## Rojo contra el tronco (base `8cf1f6c`), mismas pruebas

```
tsx --test src/chat-state.test.ts      # tests 20, pass 17, fail 3
  not ok 13 - chats.update from the phone: pin / mute on the canonical row, marked-unread keeps a badge
      expected: 'professional:111@lid'   actual: 'professional:34600@c.us'
  not ok 15 - chats.upsert archive / unread: canonical row; a chat with no conversation keeps its own id
  not ok 16 - archive / unread of one account never reach the row of the other (same jid, shared DB)
tsx --test src/api/controller-pins.test.ts   # tests 1, pass 0, fail 1
  expected: 400   actual: 200
```

## Verde tras el cambio

```
tsx --test src/chat-state.test.ts            # tests 20, pass 20, fail 0
tsx --test src/api/controller-pins.test.ts   # tests 1, pass 1, fail 0
pnpm --filter @mcp-socialmedia/connector test (lista explícita de package.json)
                                             # tests 567, pass 566, fail 0, skipped 1
pnpm contract:check                          # Socialmedia contract OK (73 tools)
python3 scripts/render-connectors.py --check # exit 0
tsc --noEmit (connectors/whatsapp-web)       # exit 0
eslint (ficheros tocados)                    # 0 errores
```

## Criterios

- Un estado de archivo o no leído que informa el móvil se escribe en la conversación canónica, no en una lápida: pruebas 13 y 15.
- Una cuenta no escribe sobre la fila de otra con el mismo jid en la misma base: prueba 16.
- Sin conversación para el jid la escritura sigue siendo el `UPDATE` sobre su propio id: prueba 15.
- `POST /messages/pins` rechaza con 400 un `conversationId` que no es una cadena: `controller-pins.test.ts`.
- Ninguna tool ni ruta cambia y `CONTRACTS.yaml` no gana ni pierde entradas: solo el texto de la nota de `messages-pins.v1` y `chats-modify.v1` (commit con `Contract-Change: migrate`); el catálogo y su digest no se tocan.

Tras fusionar el tronco con la rama (merge `4064669`): suite de `connectors/whatsapp-web` 570 tests, 569 pasan, 1 omitida, 0 fallan (incluye `chat-state`, `controller-pins` y `v1-auth`); `pnpm contract:check` OK (73 tools); `tsc --noEmit` y `render-connectors.py --check` OK.

## Cuadro del paso 0 (copia de 50-entrega.md)

Los tests del fork (PR #74, `connectors/whatsapp-web`, head `7b81bd24`) se copiaron sin su código y se ejecutaron uno a uno contra el tronco (base `8cf1f6c`) con `tsx --test <fichero>`. Clases: (a) falla una aserción sobre un módulo que el tronco ya tiene · (b) falla porque el módulo, el DDL o la ruta del fork no existen en el tronco · (c) depende de una ruta o alias excluido · pasa.

| test del fork (nº de tests) | resultado contra el tronco | clase | equivalente en el tronco / decisión |
|---|---|---|---|
| `archive-client` (1) | falla: `client.syncArchiveSnapshot is not a function` | (b) | Al reconectar `resyncChatState` llama a `resyncAppState` (parches desde la versión guardada). No hay prueba de comportamiento del tronco que falle sin un WhatsApp real. No entra |
| `archive-snapshot` (6) | falla: `ERR_MODULE_NOT_FOUND ./archive-snapshot` | (b) | Lee el snapshot completo del app-state con internals de Baileys; `CLAUDE.md` ya lo deja fuera. No entra |
| `archive-persistence` (3) | falla: `db-writer` no exporta `applyArchiveSnapshot` | (b) | Escritura en bloque con el esquema del fork. No entra |
| `archive-group-names` (2) | falla: `ERR_MODULE_NOT_FOUND ./archive-group-names` | (b) | Solo sirve al snapshot; sin llamador. No entra |
| `chat-pin-state` (2) | falla: `ERR_MODULE_NOT_FOUND ./chat-pin-state` | (b) | Test 1: equivalente `pinFromBaileys` (`chat-state.ts`), sus aserciones pasan adaptadas. Test 2: escribe en `whatsapp_chat_state`, tabla del fork. No entra |
| `chat-state`, versión del fork (18) | 17 pasan, 1 falla (#13 `chats.update from the phone…`) | #13 = (a) | Señala un hueco real (H1, abajo). Entra con prueba propia: `chat-state.test.ts` 13, 15 y 16 |
| `blocked-contacts` (7) | falla: no exporta `parseProviderBlocklist` | (b) | Con un adaptador a `providerBlocklistEntries` del tronco pasan 7/7; `GET /contacts/blocklist` ya existe y su prueba pasa sin adaptar. No entra |
| `capabilities-client` (18) | 6 pasan, 12 fallan (`getCapabilityPresence`, `deleteCapabilityMessageForMe`…) | (c) | `whatsapp-capabilities.ts` está excluido. Los 6 que pasan ya están en el tronco. No entra |
| `controller-pins` (1) | falla: espera 400, recibe 200 | (a) | Hueco real (H2). Entra: `api/controller-pins.test.ts`, sin el rechazo de `@broadcast` / `@newsletter` |
| `pinned-client` (3) | falla: `ERR_MODULE_NOT_FOUND ./whatsapp-capabilities` | (b)/(c) | Equivalente `BaileysClient.pinMessage` / `listPinnedMessages`, probado en `message-stars-pins.test.ts` (16, pasan). No entra |
| `pinned-messages` (6) | falla: `ERR_MODULE_NOT_FOUND ./pinned-messages` | (b) | Equivalente `pinContent` / `pinActionOf` / `recordMessagePin` (`message-stars-pins.ts`, migración 018); 3 aserciones adaptadas pasan. No entra |
| `pinned-send` (4) | falla: `ERR_MODULE_NOT_FOUND ./pinned-send` | (b) | Idempotencia ya cubierta por `Idempotency-Key` (`send-idempotency.ts`). No entra |
| `pinned-store` (5) | falla: `ERR_MODULE_NOT_FOUND ./pinned-store` | (b) | Tabla y DDL del fork; el tronco usa `whatsapp_message_pins` (migración 018). No entra |

Ninguno de los que fallan por módulo ausente prueba un defecto del tronco; los dos huecos reales son:

- **H1.** `setConversationState` escribía `archived` y `unread_count` de `chats.update`, `chats.upsert` e historia en el id propio del jid, aunque esa conversación estuviera fundida en otra (`merged_into`), mientras el fijado y el silencio del mismo evento iban a la fila canónica. Cierre: `recordInboundConversationState` en `chat-state.ts` y los tres sitios de `baileys-client.ts`.
- **H2.** `POST /messages/pins` convertía con `String()` un `conversationId` que no era una cadena. Cierre: 400 `invalid_request`.

## Autoría adoptada

Un único commit de la rama adopta trabajo del fork: `api/controller-pins.test.ts` (copiado de la PR #74 de Jordi Ibáñez y acotado a la validación de tipo). Lleva el trailer del fork tal como va en el commit:

| commit | qué adopta del fork | trailer en el commit |
|---|---|---|
| `65ce078` | `connectors/whatsapp-web/src/api/controller-pins.test.ts` | `Co-authored-by: Jordi Ibáñez <staticduo@gmail.com>` |

`a99da6f` solo toca `.company/` (evidencia y nota de cambio) y no adopta código del fork; el commit de merge no aporta código propio.
