# SKIRM-129 · evidencia (conector WhatsApp: envío de medios, F4d)

Donde corrió: worktree de la rama `SKIRM-129-f4d`, `connectors/whatsapp-web`, Node 22, sin base de datos en las pruebas (pool de `pg` sustituido), base `5a5d95b` (`origin/deploy/prod`, F4a, F4b y F4c incluidas).

## Autoría adoptada

El escenario del nombre de documento (`data uploads preserve a safe document filename and provider receipt`, `media-send.test.ts`) viene del fork de Jordi Ibáñez (PR #74, cabeza `a5ffeac`), adaptado a la ruta del tronco. No se adopta código del fork, solo ese escenario.

`Co-authored-by: Jordi Ibáñez <staticduo@gmail.com>` va en el commit de la rama y en la descripción de la PR (el squash toma el texto de la descripción).

## Cuadro del paso 0

Los dos ficheros del fork (`gif-send.test.ts`, `media-send.test.ts`) se copiaron sin su código y se ejecutaron uno a uno con `tsx --test <fichero>` contra el tronco, con `DATABASE_URL` y `CONNECTOR_SHARED_SECRET` de prueba. Los ficheros copiados no entran en la PR. Clases: (a) falla una aserción sobre `/messages/media/send`, `sendFile` o sus ayudantes, que el tronco ya tiene · (b) falla porque el módulo, el DDL o la ruta del fork no existen en el tronco · (c) depende de una ruta, alias o vocabulario excluido · «pasa».

```
tsx --test src/gif-send.test.ts     # tests 2,  pass 0, fail 2
tsx --test src/media-send.test.ts   # tests 14, pass 5, fail 9
```

| fork | test | resultado contra el tronco | clase | decisión |
|---|---|---|---|---|
| `gif-send` | rejects raw GIF uploads with an HTTP failure before calling Baileys | falla: 200 en lugar de 400 (sale como imagen) | **(a)** | **Rechazada, a la espera del architect (C4).** Ver «C4» abajo: la consola `dgx-messages` recibe hoy 200 por esta ruta con un `.gif` |
| `gif-send` | sends transcoded MP4 as a GIF playback payload | falla: `asGif` no existe y falta `mimetype` | (c) | Vocabulario `asGif` en `sendFile`. El tronco envía GIFs por `POST /messages/gif` (`sendStickerOrGif`), que ya manda `{video, mimetype: 'video/mp4', gifPlayback: true, caption}` y lo fijan `sticker-gif.test.ts` («bytes: … MP4 GIF with gifPlayback», «client: an MP4 goes as a GIF») |
| `media-send` | an existing video attachment gains provider duration without redownloading | falla: `Cannot read properties of undefined (reading 'warn')` | (b) | Persistencia de medio entrante (`downloadAndStoreMedia` con `SELECT … FROM attachments` y `duration_seconds`), otro flujo que el del tronco (`uploadMedia` + `storeAttachment`) y no el de envío |
| `media-send` | channel media persists original payload outside chats and keeps receipt on store failure | falla: `Must not enter chat retry cache` | (b) | `novedadesIngestStore` / `persistSentNovedades` no existen en el tronco (canales, F4c) |
| `media-send` | sent status keeps captured owner identity when connection changes during send | falla: `reading 'size'` | (b) | El mismo `novedadesIngestStore`, para estados (`sendVoice` a `status@broadcast`) |
| `media-send` | data uploads preserve a safe document filename and provider receipt | falla: `'..report.pdf'` en lugar de `'report.pdf'` | **(a)** | **Cerrada.** Además, sin `fileName` una URL `data:` daba `pdf;base64,YQ==` (el fork espera `attachment`). Pasa tras el cambio |
| `media-send` | image send forwards caption and preserves provider receipt after storage failure | falla: `stored` es `false` | (b) | `persistSentMedia` (guardar el medio enviado) no existe en el tronco. Ese mismo test envía un WebP esperando foto: ver el test «expanded alpha WebP» |
| `media-send` | document and video sends persist the correct media type before receipt | falla: `'receipt-0'` en lugar de `'receipt-1'` | (b) | `persistSentMedia` |
| `media-send` | missing quoted media is rejected before WhatsApp send | pasa | pasa | |
| `media-send` | media reservation is claimed immediately before provider send with its stable ID | pasa | pasa | |
| `media-send` | media persistence lock serializes competing echo and local writes | falla: `withMediaPersistenceLock is not a function` | (b) | Cerrojo interno del fork para `persistSentMedia` |
| `media-send` | quality changes the bytes actually sent, preserves alpha and source, and never upscales | pasa | pasa | |
| `media-send` | expanded alpha WebP exceeding the inline limit fails before token claim or provider send | falla: el tronco responde `quality_unsupported` («got a sticker») en lugar de `image_too_large` | **(a)** | **Rechazada, sin ruling.** Exige que un `image/webp` deje de ser sticker por defecto en `sendFile` (hoy `asSticker = … \|\| contentType === 'image/webp'`; `send-ephemeral.test.ts` envía un WebP por `sendFile` sin bandera). Es otra decisión de producto: un WebP sin `asSticker` pasaría de sticker a foto para quien llame (por ejemplo `social_send_media`). No hay un 200 roto que arreglar |
| `media-send` | view-once travels in the Baileys payload for image and video only | pasa | pasa | |
| `media-send` | view-once is refused for sticker, GIF, audio and document before the socket | falla: `Missing expected rejection` | (c) | Sondeado caso a caso en el tronco: sticker, GIF por contenido, audio y documento se rechazan con `view_once_unsupported`; solo falla el caso «gif by flag» (`asGif: true`), vocabulario excluido |
| `media-send` | view-once accepts only the proxy-aligned MIME set before the socket | pasa | pasa | |

Resultado: 16 tests clasificados. (a): 3 (una cerrada, dos rechazadas con motivo). (b): 6. (c): 2. Pasan: 5.

## C4: quién recibe 200 hoy por un GIF crudo

Sondeo en el tronco: `sendFile` con `data:image/gif` y sin opciones envía un mensaje `image` (200); con `asSticker` envía un `sticker` con los bytes del GIF (200). El 400 del fork salta antes que `asSticker` (`normalizedContentType === 'image/gif'`), así que alcanza a los dos.

Llamadores por `POST /messages/media/send` (lectura del código en los clones de `~/k8s`):

- `dgx-messages`, `routes_messages.py`, `send_media`: manda el `Content-Type` que declara el navegador (`kind` `file`, `photo`, `sticker`), y `chat-pane.jsx` (`pickFile`) ofrece `image/*`, `*/*` y, para stickers, `image/webp,image/png,image/gif`. Un `.gif` elegido ahí recibe 200 hoy y recibiría 400 (la consola lo muestra como 502 `connector 400`).
- `dgx-messages`, `send_sticker_url` (Giphy y recientes): guarda con extensión `gif` cuando el origen declara `image/gif` y llama con `asSticker: true`: 200 hoy, 400 con el fork.
- `mcp-server`, `handleSendFile` (`social_send_media` y `social_send_message` con adjuntos): pasa la URL que dé el agente tal cual; ninguna prueba del repo fija un `.gif` por esta ruta (los `.gif` de sus pruebas van a `social_send_gif`, que usa `/messages/gif`).
- `dgx-infra`, `services/dashboard/api/routes_messages.py`: la copia anterior de esa consola hace las mismas llamadas.
- `jarvis` y `synapse`: sin llamada de medios de WhatsApp por esta ruta (la de `jarvis` es de Telegram).

Es lectura del código, no una medición de qué reciben hoy las cuentas reales. Con un llamador que depende del 200 la spec manda parar: no se cambia, se devuelve al architect.

## Rojo contra el tronco, mismas pruebas

```
tsx --test src/qa-1002-ingest.test.ts   # tests 14, pass 12, fail 2
  not ok 2  - documentFileName: explicit name wins; URL path without the presigned query
      expected: 'passwd'   actual: '..etcpasswd'            (cleanFileName('../etc/passwd\u0000'))
  not ok 13 - POST /messages/media/send: a document name is its last path segment, never glued across directories
      expected: 'report.pdf'   actual: '..report.pdf'
```

El test 12 (caracterización de imagen, vídeo, audio y documento: 200 con exactamente `{sent, sentAt}` y el contenido de cada tipo) pasa antes y después. El test 2 cambia la aserción vieja `cleanFileName('../etc/passwd\u0000') === '..etcpasswd'`, que fijaba el comportamiento que este cambio corrige (la nota `migrate` lo explica).

## Verde tras el cambio

```
tsx --test src/qa-1002-ingest.test.ts       # tests 14, pass 14, fail 0
tsx --test src/media-send.test.ts (fork)    # el test «data uploads preserve a safe document filename…» pasa: pass 6, fail 8 (los 8 son (b), (c) y el WebP rechazado)
pnpm --filter @mcp-socialmedia/connector test (lista explícita de package.json)
                                            # tests 594, pass 593, fail 0, skipped 1 (ninguno de los inestables cayó)
pnpm contract:check                         # Socialmedia contract OK (73 tools)
python3 scripts/render-connectors.py --check  # exit 0
tsc --noEmit (connectors/whatsapp-web)      # exit 0
eslint (connectors/whatsapp-web)            # 0 errores
check-contracts.py --range origin/deploy/prod..HEAD  # contracts: OK (101 entries)
company-duplicados --base origin/deploy/prod          # sin duplicación nueva
```

## Criterios de la spec

- C1: cuadro arriba, 16 de 16 clasificados; las tres (a) están cerradas o rechazadas con motivo escrito.
- C2: dos pruebas de comportamiento rojas sobre el tronco y verdes tras el cambio (`qa-1002-ingest.test.ts` 2 y 13). Están en un fichero que ya figura en `scripts.test`; la prueba HTTP arranca la app con `fetch`, sin `supertest`.
- C3: sin `fileName`, el último segmento de la URL ya era el nombre y ahora también lo es tras decodificarla (`https://x/..%2Freport.pdf` → `report.pdf`); una URL `data:` da `attachment`. Con `fileName` se conservan `invalid_file_name` (400 si no es cadena) y la limpieza de caracteres de control y el límite de 200; cambia que solo cuenta su último segmento (`../report\n.pdf` → `report.pdf`). La spec dice que la limpieza actual no cambia, pero su propio fixture (`'../report\n.pdf'` con `fileName`) exige `report.pdf`; se ha seguido el fixture. El caso del fork pasa.
- C4: sin cambio. Devuelto al architect (arriba).
- C5: caracterización verde antes y después (test 12); `Idempotency-Key` sin tocar (`send-idempotency.test.ts` sigue verde). El hash de una petición lleva `fileName` ya limpio, así que una con directorios en el nombre cambia de hash.
- C6: ninguna tool ni ruta cambia (`pnpm contract:check`). `CONTRACTS.yaml`: solo el texto de la nota de `messages-media-send-filename.v1`; commit con `Contract-Change: migrate`; nota en `.company/changes/skirm-129-nombre-documento.md`.
- C7: suite, `tsc`, `eslint`, `render-connectors.py --check` y `company-duplicados` sin hallazgos; `ARCHITECTURE.md` no menciona el nombre del documento, no hizo falta tocarla; `CLAUDE.md` (sección del nombre del documento) actualizada; `Co-authored-by` de Jordi en el commit y en la descripción.
- C8: no aplica (hay una (a) cerrada).
