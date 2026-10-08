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
