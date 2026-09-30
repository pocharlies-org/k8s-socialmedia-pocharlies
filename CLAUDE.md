# whatsappmcp — Notas para Claude

## Qué es

Servidor MCP multi-plataforma (WhatsApp + Telegram + Instagram) que expone tools a Claude/LLMs por SSE. Almacena mensajes en Postgres+pgvector, usa Redis (cache), MinIO (ficheros) y NATS (event bus). LLM vía LiteLLM.

## Dónde corre

- **Producción actual: k8s namespace `whatsapp-mcp`** (sauvage / ubuntu node)
- ArgoCD app: `socialmedia` → repo `pocharlies/k8s-socialmedia-pocharlies`, branch `deploy/prod`, path `k8s/overlays/prod`
- Promoción: workflow_dispatch en `.github/workflows/release.yml` o tag push
- El stack docker-compose viejo en sauvage `~/mcp-socialmedia/` está parado a propósito desde 2026-05-22 (migración a k8s). NO arrancarlo.
- Imágenes en Harbor: `harbor.e-dani.com/homelab/whatsappmcp-*`

## Multi-account (personal / professional / leila)

El MCP enruta cada call a una de tres cuentas de WhatsApp (y dos de Telegram):

| Account | Telegram | WhatsApp |
|---|---|---|
| `personal` (**default**) | `telegram-connector` — sesión `paxanguero` | `whatsapp-connector` — Baileys (número personal) |
| `professional` | `telegram-connector-professional` — sesión `sauvageadminbot` (skirmshop) | `whatsapp-connector-professional` — Baileys (número de negocio) |
| `leila` | — (sin conector Telegram; `accountId: 'leila'` + `channel: 'telegram'` = "not configured") | `whatsapp-connector-leila` — Baileys (número de Leila), **desplegada pero SIN emparejar** |

- **Las tres cuentas de WhatsApp son Baileys (WhatsApp Web)** — cada una un Deployment con su número, sesión y PVC propia. NO se usa Cloud API (eliminado: el usuario no quiere pagar a Meta y quiere contestar a mano desde el móvil; Baileys es un dispositivo vinculado).
- Para indicarle al MCP qué cuenta usar pasa `accountId: 'personal' | 'professional' | 'leila'` en la tool call (el parámetro canónico se llama `accountId`; el `account` interno de los handlers se deriva de él).
- Default global: `personal`. Si el chat es claramente de skirmshop/business → pasar `professional`.
- Para agentes/sesiones de Claude/Codex/OpenClaw que NO sean específicamente "hogar"/"familia", la guía es: **siempre `account: 'professional'`** salvo que el chat destino sea familiar/personal.
- Vincular el número professional: escanear el QR en `https://whatsapp-pro.e-dani.com/qr/page`.
- Vincular el número de Leila (pendiente del operador — SC-1144 criterio 2): QR **solo por LAN** en `https://whatsapp-leila.lan.e-dani.com/qr/page` (botón de renovar activo vía `ALLOW_WEB_RENEW`, igual que professional). NUNCA exponerla al edge: la página pública del personal (`whatsapp.e-dani.com`) es legado y no se replica.

DB scoping (migración 002): los ids de la cuenta `personal` no llevan prefijo (compat con ~449k filas existentes); los de `professional` van prefijados `professional:` y los de `leila` `leila:`. La columna `account` está indexada para filtros rápidos.

### Payloads duraderos de WhatsApp (fase 3 / PR-1, migración 009)

El conector guarda el WAMessage crudo (key + contenido, BufferJSON, sin miniaturas ni material de claves) en `whatsapp_message_payloads` con los mismos ids namespaced que `messages` (`connectors/whatsapp-web/src/durable-message-store.ts`). Lo usan: citar al responder, `/api/v1/messages/forward` (reenvío real `{ forward }`, 404 `message_unavailable` si no hay original) y el `getMessage` de reintentos de Baileys — memoria primero, luego la copia duradera. Se guarda tráfico vivo y envíos propios; history-sync solo si es más reciente que `DURABLE_PAYLOAD_HISTORY_DAYS` (7 por defecto, 0 = nunca); tope `DURABLE_PAYLOAD_MAX_BYTES` (256 KiB). Sin la tabla (009 sin aplicar) falla en blando: un log y comportamiento en memoria, re-sondea cada 5 min. La pool de emparejamiento (`ingest: false`) nunca la toca. Retención (PR-2): filas con `created_at` de más de `DURABLE_PAYLOAD_RETENTION_DAYS` (90 por defecto, 0 = sin purga) se borran por lotes de 5000, como mucho una vez por hora (`connectors/whatsapp-web/src/retention.ts`).

### Idempotencia de envíos de WhatsApp (fase 3 / PR-2, migración 010)

**Opt-in**: solo con `Idempotency-Key` (cabecera) o `idempotencyKey` (body) en `/api/v1/messages/send`, `/messages/media/send` y `/messages/audio`. **Nunca por `sendToken`**: synapse, dgx-messages y skirmshop-labels reusan un token constante; sin clave las rutas responden exactamente lo de siempre. Con clave (`connectors/whatsapp-web/src/send-idempotency.ts`, tabla `whatsapp_send_attempts`, PK `(account, sha256(clave))`, la clave en claro nunca se guarda): misma clave + misma petición → el resultado grabado con `deduplicated: true` sin reenviar; otra petición → 409 `idempotency_key_reused`; intento en `pending` (caída o timeout tras el envío) → 409 `send_outcome_uncertain` con el `messageId`. El id de WhatsApp sale de (cuenta, clave) (`3EB0…`), así un reintento es el mismo mensaje. Sin la tabla (010 sin aplicar) la clave se ignora y se envía igual. Ventana de 7 días (`WA_SEND_ATTEMPT_RETENTION_DAYS`). El MCP (`social_send_message` con `idempotencyKey`) manda una clave derivada por sub-operación (texto, cada adjunto) además de su idempotencia en Redis. Contrato `http.whatsapp-connector.send-idempotency.v1`.

### Editar y eliminar mensajes de WhatsApp (fase 3 / PR-3, sin migración)

`POST /api/v1/messages/edit` `{chatId, messageId, content, actor?}` (solo texto propio) y `POST /api/v1/messages/delete` `{chatId, messageId, forMe?, actor?}` (`forMe: false` = para todos / revoke; `true` = para mí). Mismo gate que los envíos (`ENABLE_SENDING` + `EMERGENCY_DISABLE_SENDING` → 403). La clave real sale de memoria → `whatsapp_message_payloads` → `whatsapp_message_keys` → fila de `messages` (sobrevive reinicios; el chat sale de la clave, no de la petición). Escribe el conector (`connectors/whatsapp-web/src/message-mutations.ts`), solo con `ingest` (la pool de emparejamiento nunca), por id namespaced + `account_id`, y **nunca destruye**: editar → `content` nuevo, `is_edited`, el texto anterior a `metadata.edit_history` (`[{content, replaced_at, source, actor?}]`); para todos → `is_deleted`, `status='deleted'`, `metadata.deleted_at`, el contenido se queda; para mí → solo `metadata.deleted_for_me` (+`_at`), `is_deleted` intacto. Lo mismo para lo que llega de WhatsApp (edición/revoke de un contacto o desde nuestro móvil; borrar-para-mí sincronizado del móvil); el eco de nuestra propia acción lo deja pasar el handler durante 30 s y lo persiste la llamada explícita cuando WhatsApp la aceptó (un rechazo por ack, p. ej. fuera de la ventana de edición, es 422 `rejected_by_whatsapp`). NATS `whatsapp.MessageUpdated`: `EDITED` (con `newContent`) y `DELETED`, ahora con `account`; borrar-para-mí **no** se publica. `social_delete_message` (MCP) usa `POST /messages/delete`; `DELETE /messages/:chatId/:msgId` sigue como alias. Contratos `http.whatsapp-connector.messages-edit.v1` / `messages-delete.v1`.

### Reacciones de WhatsApp (fase 3 / PR-4, migración 011)

Lo de siempre sigue igual: la reacción entra como mensaje `REACTION` y el trigger de prod `trg_merge_inbound_reaction` (`merge_inbound_reaction()`, **no está en ningún repo**) la pliega en `messages.reactions` del mensaje destino (`{emoji: [reactor|"me"]}`, lo que pinta dgx-messages) y descarta la fila (0 filas `REACTION` en prod). Además, el conector (`connectors/whatsapp-web/src/message-reactions.ts`, solo con `ingest`) guarda cada reacción —de un contacto, de nuestro móvil o enviada por nosotros— en `whatsapp_message_reactions`: una fila actual por (cuenta, mensaje, reactor), cambiar el emoji la actualiza, quitarlo pone `removed` y conserva el último emoji, nada se borra; una reacción más antigua (history sync) no pisa a una más nueva (`reacted_at`). El trigger rellena `account_id`, pone la conversación del mensaje destino y archiva un reactor PN (`@c.us`/`@s.whatsapp.net`) bajo su `@lid` si `social_contact_aliases` lo sabe (alias bloqueado o ambiguo → no colapsa); `trg_social_redirect` + merge/unmerge re-declarados como en 009. Lectores: la vista `whatsapp_message_reactions_current` (vuelve a colapsar PN/LID al leer, oculta las quitadas; filtrar por `target_wa_message_id` o `conversation_id`). Sin la tabla (011 sin aplicar) falla en blando: un log, re-sondea cada 5 min. `POST /api/v1/messages/react` `{conversationId, messageId, emoji}`: mismo gate que los envíos (`ENABLE_SENDING` + `EMERGENCY_DISABLE_SENDING` → 403), clave de memoria → payloads → keys → `messages` (sobrevive reinicios), mensaje desconocido → 404 `message_unavailable` (antes 200 sin enviar nada), errores `{error, failureClass}`. Sin evento NATS. Contrato `http.whatsapp-connector.messages-react.v1`. Sin backfill: la historia vive en `messages.reactions`.

### Archivar, fijar, silenciar y leído/no leído de WhatsApp (fase 3 / PR-5, migración 012)

`POST /api/v1/chats/modify` `{conversationId, action, durationMs?, muteUntil?, actor?}` con `action` ∈ archive, unarchive, pin, unpin, mute, unmute, markRead, markUnread (`connectors/whatsapp-web/src/chat-state.ts` + `modifyChat` en `baileys-client.ts`). Mismo gate que los envíos (`ENABLE_SENDING` + `EMERGENCY_DISABLE_SENDING` → 403). El chat se resuelve a su conversación **canónica** (`account_id` + `external_id`, siguiendo `merged_into`, o `social_contact_aliases` no bloqueado) y el parche de app-state va al jid de la clave de su último mensaje (memoria → payloads → keys → `messages`, sobrevive reinicios), que es también el `lastMessages` que piden archivar y leído. Silenciar manda el `muteEndTimestamp` de WhatsApp (epoch ms absoluto, −1 = siempre; el fork pasaba la duración tal cual). markRead = los acuses de lectura pendientes (lo de `/messages/read`) + la marca de app-state (quita el punto de "no leído"). Sin tabla nueva (la `whatsapp_chat_state` del fork duplicaba `conversations`): 012 añade a `conversations` `pinned_at` (NULL = no fijado), `muted` + `mute_until` (silenciado con `mute_until` NULL = siempre; el efectivo es `muted AND (mute_until IS NULL OR mute_until > now())`, sin `infinity`: psycopg/asyncpg no lo cargan); archivar/leído siguen en `archived`/`unread_count` (no leído = `unread_count ≥ 1`). Escribe solo con `ingest`, en la fila canónica, tras aceptarlo WhatsApp. Lo que hace el móvil llega por `chats.update` (fijar/silenciar, a la canónica; archivar/no leído por el `setConversationState` de siempre, que ahora deja el badge ≥ 1 con el −1 de "marcar no leído" y ya no lo pone a 0 en un delta solo de archivado). `social_merge_conversation` re-declarada (cuerpo de 011 + la canónica hereda fijado/silenciado de la lápida, como `flagged`); unmerge sin tocar. Sin las columnas (012 sin aplicar) falla en blando: fijar/silenciar salen a WhatsApp con `persisted: false`, un log, re-sondea cada 5 min; archivar/leído igual que siempre. "Destacar" no es de WhatsApp a nivel de chat (WhatsApp destaca mensajes): en dgx-messages es el `flagged` de la consola. Fuera de este PR: el snapshot de archivo del fork (`/chats/archive-snapshot/*`, internals de Baileys, escribe en bloque y crea gemelas PN) y una tool MCP. Contrato `http.whatsapp-connector.chats-modify.v1`.

### Gestión de grupos de WhatsApp (fase 3 / PR-6, sin migración)

Cuatro rutas, ids dentro del cuerpo firmado y solo jids de grupo (`…@g.us`, con o sin prefijo de cuenta; un chat directo, un `@lid` o el prefijo de otra cuenta es 400 antes de nada): `POST /api/v1/groups/state` `{groupId}` (lectura, sin gate), `POST /groups/create` `{subject, participants[], actor?}`, `POST /groups/update` `{groupId, subject?, description?, settings?: {announce?, restrict?}, actor?}` y `POST /groups/participants` `{groupId, action: add|remove|promote|demote, participants[], actor?}` (`connectors/whatsapp-web/src/group-management.ts` + `createGroup` / `updateGroup` / `updateGroupParticipants` / `getGroupState` en `baileys-client.ts`, portado del fork). Las tres que cambian el grupo notifican a gente real: mismo gate que los envíos (`ENABLE_SENDING` + `EMERGENCY_DISABLE_SENDING` → 403), después de validar. Participantes: 1–50 teléfonos (E.164, `00…`, o 9 cifras con `WA_DEFAULT_COUNTRY_CODE`) o jids PN/LID; cualquier entrada que no lo sea rechaza la petición entera. Lo que la cuenta puede hacer sale de **su propia fila de participante** (por PN o LID) en metadatos frescos: asunto/descripción = admin, o miembro si el grupo no está `restrict`; ajustes, quitar, ascender y degradar = admin; añadir = admin o miembro con el modo "todos pueden añadir" → si no, 403 `not_group_admin` / `not_group_member`; comunidades → 422 `community_unsupported`; la propia cuenta en la lista → 422 `self_participant`. Un miembro va con el jid que el grupo conoce (un PN de un miembro LID sale como su LID). WhatsApp contesta por participante y se devuelve cada respuesta (`status` 200/403/408/409…, `reason` `invite_required`, `recently_left`, `already_participant`…): alguno hecho → 200 con `partial`; ninguno → 422 `rejected_by_whatsapp` con los `results`. Crear: Baileys tira los errores por participante de la respuesta, así que `added`/`not_added` sale de si están en los metadatos devueltos. Actualizar no manda lo que ya tiene ese valor, y un fallo a mitad dice qué se aplicó (`applied`). BD (solo con `ingest`): la fila `conversations` del grupo al crearlo (y en `groups.upsert`: grupos nuevos de otros con nosotros dentro; id namespaced + `account_id` + `external_id`, `last_message_at` = creación; una fila viva existente solo recibe nombre y tamaño), el asunto nuevo en la canónica (también desde `groups.update`, lo cambie quien lo cambie) y `participant_count` tras cambiar participantes; descripción, ajustes y admins no se guardan — quien los quiera pregunta a `/groups/state`. `GET /groups/:id/info` y `/participants` intactos. Sin evento NATS nuevo. Fuera: comunidades, invitaciones (a quien pide invitación, el 403) y tool MCP. Contratos `http.whatsapp-connector.groups-{state,create,update,participants}.v1`.

### Encuestas y eventos de WhatsApp (fase 3 / PR-7, migración 013)

Seis rutas, ids en el cuerpo firmado: `POST /api/v1/messages/poll` `{conversationId, name, options[2..12], selectableCount?, actor?}` (0 = cualquier número, 1 = única), `/messages/poll/vote` `{conversationId, messageId, options[], actor?}` (la selección completa; `[]` retira el voto), `/messages/poll/results` `{conversationId, messageId}`, `/messages/event` `{conversationId, name, description?, startTime, endTime?, location?, call?, extraGuestsAllowed?, actor?}`, `/messages/event/respond` `{conversationId, messageId, response: going|not_going|maybe, extraGuestCount?, actor?}` y `/messages/event/results` (`poll-votes.ts`, `event-responses.ts`, `poll-event-store.ts` + `sendPoll` / `sendPollVote` / `getPollResults` / `sendEvent` / `respondToEvent` / `getEventResults` en `baileys-client.ts`, portado del fork). Las cuatro que llegan a gente: validación (400) → mismo gate que los envíos (`ENABLE_SENDING` + `EMERGENCY_DISABLE_SENDING` → 403) → 503 → `Idempotency-Key` opt-in de PR-2; los resultados son lecturas sin gate. Chats: grupo, `@c.us`/`@s.whatsapp.net` o `@lid` (una conversación fusionada envía a su canónica). Antes de PR-7 no había nada: un voto entraba como fila vacía `POLLUPDATEMESSAGE` (296 en prod, indescifrables) y una encuesta como `MESSAGECONTEXTINFO`/`POLLCREATIONMESSAGEV3` sin contenido; esas filas se quedan. Ahora una encuesta / evento es una fila `POLL` / `EVENT` (content = pregunta / nombre, `metadata.poll` / `metadata.event`) y su payload (con el `messageSecret`, que nunca va a `messages`) se guarda sea cual sea su antigüedad. Un voto / respuesta **no** es fila de `messages` (tampoco sale por NATS): se descifra con el secreto de la encuesta (memoria → `whatsapp_message_payloads`) probando cada identidad conocida (PN y LID, de la clave, su alternativa y el mapeo de Baileys; AES-GCM autentica, un par erróneo no da un voto falso) y se guarda en `whatsapp_poll_votes` / `whatsapp_event_responses`: una fila actual por (cuenta, mensaje, persona), cambiar la actualiza, retirar pone `retracted` y conserva la última selección, una respuesta borrada es `unknown`, nada se borra, un voto más antiguo no pisa a uno más nuevo (`voted_at` / `responded_at`). Encuesta desconocida o sin secreto → log y se salta (una encuesta anterior a los payloads de PR-1 no se puede votar ni leer: 422 `poll_secret_unavailable`). En un lote de history sync los votos van después de las encuestas. Nuestro voto se firma con las identidades con que se direcciona el chat (LID salvo que el creador sea un número, regla de whatsmeow); nuestra respuesta a un evento con números (como descifra Baileys): sin el número del creador → 422 `identity_unavailable`. El trigger de 013 pone `account_id`, la conversación de la encuesta y archiva un PN bajo su `@lid` (`social_whatsapp_reactor_lid` de 011); `trg_social_redirect`, merge/unmerge re-declarados (012/011 + las dos tablas) y `pg_notify('message_updated', {id, conversation_id, kind: poll|event})` para refrescar /messages. Lectores: `whatsapp_poll_votes_current` / `whatsapp_event_responses_current`. Sin las tablas (013 sin aplicar): un log, re-sondea cada 5 min, enviar sigue funcionando (`persisted: false`). Solo con `ingest` (la pool de emparejamiento nunca). Sin tool MCP. Contratos `http.whatsapp-connector.messages-{poll,poll-vote,poll-results,event,event-respond,event-results}.v1`.

### Presencia, privacidad y mensajes temporales de WhatsApp (fase 3 / PR-8, migración 014)

Seis rutas, ids en el cuerpo firmado (`connectors/whatsapp-web/src/presence.ts`, `privacy-settings.ts`, `disappearing.ts` + `sendPresence` / `getPresence` / `getPrivacySettings` / `updatePrivacySetting` / `getDisappearing` / `setDisappearing` en `baileys-client.ts`, portado del fork). Las lecturas no llevan gate; lo que llega a WhatsApp valida (400) → mismo gate que los envíos (`ENABLE_SENDING` + `EMERGENCY_DISABLE_SENDING` → 403) → 503.

- **Presencia.** `POST /api/v1/chats/presence` `{conversationId?, state, actor?}`: `composing` / `recording` / `paused` van como chat-state a ESE chat (el "escribiendo…" del operador; no cambia la disponibilidad de la cuenta; mismo estado al mismo chat en < 3 s no se reenvía). `unavailable` es de toda la cuenta (sin `conversationId`). **Nunca `available` implícito**: estar en línea en un dispositivo vinculado hace que el móvil de la cuenta deje de recibir notificaciones push; `markOnlineOnConnect: false` se queda y un `available` explícito es 403 `presence_available_disabled` salvo `WA_PRESENCE_ALLOW_AVAILABLE=true` (por defecto off; no está puesto en ningún overlay). `POST /chats/presence/read` `{conversationId, participant?}`: lo último que dijo `presence.update`, **solo en memoria** (60 s en línea/desconectado, 8 s escribiendo/grabando, se borra en cada reconexión, sin tabla), buscado bajo el PN y el LID del chat; nada fresco → `unknown` (nunca un "en línea" viejo) y re-suscribe el chat como mucho cada 30 s (`refreshing: true`). Las suscripciones de presencia ahora se limpian al reconectar (antes el `Set` sobrevivía al socket y tras una reconexión no se volvía a suscribir nada). El aviso de "escribiendo…" a dgx-messages (`/_connector/typing`) sigue igual.
- **Privacidad.** `GET /api/v1/privacy` (fresca de WhatsApp) y `POST /privacy` `{setting, value, confirm: true, actor?}`: cambia la CUENTA para todo el mundo, así que nombres y valores exactos de Baileys (lastSeen/profilePicture/status: all|contacts|contact_blacklist|none; online: all|match_last_seen; readReceipts: all|none; groupsAdd: all|contacts|contact_blacklist; call: all|known; messages: all|contacts; defaultDisappearing: 0|86400|604800|7776000), sin `confirm: true` → 400 `confirm_required`; lee el valor actual primero y no manda uno igual. No se guarda nada.
- **Mensajes temporales.** `POST /chats/disappearing` `{conversationId, expiration, actor?}` (solo 0 / 24 h / 7 d / 90 d, en segundos o `off|24h|7d|90d`): grupo → metadatos frescos, miembro y admin si el grupo restringe sus ajustes (la regla `editInfo` de PR-6), `groupToggleEphemeral`; chat directo → el mensaje de temporizador que mandan los clientes oficiales. Un temporizador igual conocido no se reenvía. `POST /chats/disappearing/read` `{conversationId}`: grupo desde metadatos; chat directo desde la BD (WhatsApp no tiene consulta para el temporizador de un 1:1) + `contactDefault` (el USync `disappearing_mode` del contacto = SU valor por defecto para chats nuevos, no el de este chat). 014 añade a `conversations` `ephemeral_expiration` (segundos, 0 = off, **NULL = desconocido**) y `ephemeral_setting_at`; escribe el conector solo con `ingest`, en la fila canónica: nuestro cambio aceptado, y lo que llega por `chats.update` (cambio de cualquiera de los dos lados: Baileys convierte el `EPHEMERAL_SETTING` en `{ephemeralExpiration, ephemeralSettingTimestamp}`) y por los snapshots de history / `chats.upsert` (solo rellenan un NULL). Nunca pisa un temporizador más nuevo. Merge sin re-declarar (la lápida no se escribe; su valor no pasa a la canónica). Sin las columnas (014 sin aplicar): sale a WhatsApp con `persisted: false`, un log, re-sondea cada 5 min, lectura = desconocido.

Sin evento NATS nuevo ni tool MCP. Contratos `http.whatsapp-connector.{chats-presence,chats-presence-read,privacy-read,privacy-update,chats-disappearing-read,chats-disappearing}.v1`.

### Vínculos de identidad por usuario (SC-1144 fase 2, bandera OFF)

Un usuario verificado solo puede tocar las cuentas ligadas a su `sub` de Keycloak. La tabla vive en GitOps: `k8s/base/social-identity-bindings.yaml` (misma forma y misma postura fail-closed que `backends/workspace/identity-bindings.yaml` de k8s-agentgateway-pocharlies), montada en el pod `mcp-sse` como ConfigMap de nombre estático en `/identity/` — el código (`mcp-server/src/domain/identity-bindings.ts`) **relee el fichero cuando cambia (stat mtime+size), así editar un vínculo no reinicia el pod**.

- Bandera `SOCIAL_IDENTITY_BINDING` (default **`off`**; el repo la entrega off en base y en prod). Con OFF: cero lecturas del fichero, enrutado byte-idéntico al de siempre. Volcarla a ON es decisión del operador.
- Con ON, el gate único es `applyIdentityBinding` en `executeCanonicalTool` (todas las tools con `accountId` pasan por ahí; `social_list_accounts` no tiene `accountId` y se resuelve por actor en el conector, SC-1256: `GET /health` con flag ON y `x-user-sub` pasa cada cuenta por `resolveInstagramEntry`; un sub sin filas recibe `no_credential` y el MCP omite esas entradas IG — con `channel=instagram` error `no_instagram_credential`, sin canal `partialErrors` en `data`; sin sub o flag OFF, listado legacy intacto; ADR 0001 de SC-1256 (veredicto del arquitecto, punto 4c; no es `docs/adr/0001`): se filtra la vista, no se reestructura el catálogo. El nombre del registro no es el nombre de Instagram: un sub con fila aparece bajo cada nombre de cuenta del registro, por diseño):
  - `sub` ligado + `accountId` pedido fuera de su lista → error explícito nombrando principal y cuentas ligadas.
  - `accountId` omitido → **primera cuenta de su lista** (nunca el default global `personal`).
  - `sub` sin entrada en la tabla, o llamada sin `x-user-sub` → fail-closed, ninguna cuenta.
- El vínculo es **por cuenta, sea el canal que sea**: con ON, Instagram (`skirmshop`/`barbelpapis`) queda fail-closed para todo el mundo hasta que se añadan a la tabla.
- **Riesgo residual declarado**: `x-user-sub` lo estampa el gateway sobrescribiendo al cliente, pero `mcp-sse` es alcanzable por la ruta LAN `mcp-socialmedia.lan.e-dani.com` con el **bearer compartido**, así que quien posea ese token puede forjar la cabecera. Eso lo cierra la **Parte 5 (SC-1146, retirada de la clave compartida)**, no esta historia.

## Almacén de credenciales por usuario (SC-552 + fase 1.5 SC-705)

Decisión CTO 13-09-2026: UN almacén por `sub` del JWT que el AgentGateway verifica en `/social` y reenvía como cabecera `x-user-sub`, con tres adaptadores de canal — no tres almacenes paralelos. Implementación en `shared/src/session-store/` (desde la fase 1.5, 21-09: la consumen DOS runtimes — mcp-server y el conector whatsapp-web —; un solo código que habla con la tabla). Sus specs de regresión corren en el jest de mcp-server (`mcp-server/src/infrastructure/session-store/*.spec.ts`, que compila `shared` antes de testear).

- `credential-store.ts` — tabla `user_channel_credentials` (migración 007, PK `(session_key, channel)`). Persistencia = la DB `whatsappmcp`: sobrevive reinicios del gateway y de los pods. **El payload va CIFRADO en la capa del store** (`put` cifra, `get` descifra; la DB nunca ve texto plano): envelope AES-256-GCM con data-key aleatoria por fila envuelta por la clave maestra `CREDENTIAL_STORE_MASTER_KEY` (base64 de 32 bytes; viaja dentro del item 1Password `whatsapp-mcp` → `envFrom`; formato y justificación del envelope en `payload-crypto.ts`). Fail-closed: sin clave, `put`/`get` lanzan; una fila NO-envelope se rechaza.
- `request-context.ts` — AsyncLocalStorage alrededor de `transport.handleRequest`/`handlePostMessage` en `sse-server.ts` (por POST); expone `x-user-sub`/`x-user-name` al contexto de la tool call. Sin cabecera → contexto vacío. `actorRequestHeaders()` reenvía el actor en las llamadas HTTP del mcp-server a los conectores (SC-705).
- `adapters/` — baileys (directorio multi-file auth-state → `{files: nombre→base64}`), mtcute (session string), instagram (token Graph + ids). Cada canal conserva su formato; el store no lo interpreta.
- `credential-resolver.ts` — `resolveCredential`: (1) cabecera + fila → la fila gana; (2) sin cabecera → ruta legacy exacta, cero lecturas/escrituras; (3) cabecera sin fila → adopt-on-first-use (leer legacy, escribir fila, servir legacy).

**Cableado WhatsApp (fase 1.5, `connectors/whatsapp-web/src/credential-session.ts`)**: un conector por sesión emparejada indexa su sesión por `session_key = <sub>` (o `<sub>:<cuenta>` si un usuario tuviera dos cuentas — convención del tech-lead, el PK ya la soporta). Con `CREDENTIAL_STORE_ENABLED=true` **y** `CREDENTIAL_SESSION_KEY=<sub>`: authDir por sub (`<SESSION_PATH>/by-sub/<key>/baileys-auth`), carga de la fila antes de `connect()` (persistencia tras `rollout restart`, sin QR), write-back OBLIGATORIO de `saveCreds`→`store.put` (debounced, con trailing run) y borrado de la fila en `loggedOut`. Sin `CREDENTIAL_SESSION_KEY` (las cuentas de la casa `personal`/`professional`) o con flag OFF: ruta legacy exacta, cero lecturas/escrituras — criterio de cero regresión.

Despliegue: la migración 007 NO se aplica todavía — el Job PreSync `whatsapp-mcp-migrate` queda fuera del PR 52 (veredicto architect SC-1144: las imágenes pinneadas son pre-almacén y un PreSync que falla bloquea el sync de toda la app) y se re-añade en el PR2 junto al re-pin de imagen; `migrate.ts` ya lleva ledger `_migrations` (salta lo aplicado, baseline de esquemas previos al ledger, transacción por fichero). Estado vivo del flag `CREDENTIAL_STORE_ENABLED` (`k8s/overlays/prod`): `false` en base y en stg; ON **solo** en `instagram-connector` desde b03f60f (SC-1214 C8, `patch-credential-store.yaml`) y en los pods social-api / whatsapp-pairing / telegram-pairing (`patch-social-pairing-on.yaml`); `whatsapp-connector` con `false` explícito; los conectores telegram y mcp-server/mcp-sse no lo fijan (ausente = OFF). El callback OAuth de Instagram entra por el edge (netpol `whatsapp-mcp-allow-traefik-instagram`: allowlist /32 por nodo traefik-edge, 8bfa7d1) y por LAN (ruta `lan-instagram-callback` de k8s-infra, 5bcfb28). Pendiente de fase 2: pool multiplexado por `sub` en un solo proceso; inyección de `x-user-sub` en la ruta `/social` del AgentGateway (hoy solo la hacen `/workspace` y `/chat-*` vía `transformations.request.set`).

El mismo `request-context.ts` es la base de los **vínculos de identidad SC-1144 fase 2** (sección "Vínculos de identidad por usuario" arriba): `getRequestActor().sub` alimenta `mcp-server/src/domain/identity-bindings.ts`, gated por `SOCIAL_IDENTITY_BINDING` (default OFF, misma regla de no-regresión: sin cabecera y sin bandera, ruta legacy exacta).

## API de emparejamientos por sub (SC-1197) — topología nueva

Tres Deployment: **`social-api`** (:3020, imagen mcp-server) es la ÚNICA cara y el ÚNICO proceso del repo que verifica el JWT de Keycloak (RS256 via jose, iss `https://auth-next.e-dani.com/realms/edani`, `aud` CONTIENE `social-api`, `azp` ∈ `dgx-messages`, `typ` NO se comprueba — medido 25-09, Keycloak 26.6.2 emite `typ: JWT`); **`whatsapp-pairing`** (:3001, pool baileys por sub) y **`telegram-pairing`** (:3002, pool mtcute por sub) son pools INERTES: nunca ven un JWT, solo a social-api por el HMAC interno de siempre (`CONNECTOR_SHARED_SECRET`, cabeceras `x-connector-*`) y el `sessionKey = sub` viaja DENTRO del cuerpo firmado (todo POST; `/internal/{whatsapp,telegram}/sessions/...`). Persistencia SOLO en el credential store (las pools: emptyDir de memoria, sin PVC, `Recreate`). Rutas: `POST /pairing/{whatsapp,telegram}/start`, `GET /pairing/{whatsapp,telegram}` (QR por POLLING, no SSE), `POST /pairing/telegram/password` (2FA), `GET /me/{whatsapp,telegram}`, `GET /social/status` (siempre 200; estados `paired|expired|unpaired|unavailable`) y `GET /health` sin auth. `x-user-sub` NO es entrada de auth aquí (a diferencia del enrutado MCP). Topes: 10 sesiones concurrentes por pool; por sub 1 start/60 s, 10/día, 5 QR por start. Es el "pool multiplexado por sub" que quedaba pendiente en la fase 2 del almacén.

Flags (todas entregadas INERTES por `k8s/base/social-pairing.yaml`, P3: `replicas: 0`): `SOCIAL_PAIRING_API` (`on` = trim/lowercase; off → 404 salvo /health, en las tres caras), `CREDENTIAL_STORE_ENABLED` (`true` + `CREDENTIAL_STORE_MASTER_KEY` válida, si no 503 `pairing_unavailable`), `SOCIAL_API_ALLOWED_ORIGINS` (vacío por defecto: un `Origin` presente fuera de la lista es 403; nunca se contestan cabeceras CORS) y `SOCIAL_IDENTITY_BINDING` (NO la lee social-api: gatea las tools del MCP; `/social/status` lee los vínculos siempre, fail-closed). El resto del env es el contrato con los manifests P3 (`WHATSAPP_PAIRING_URL`, `TELEGRAM_PAIRING_URL`, `SOCIAL_API_JWT_*`, `SOCIAL_API_ALLOWED_AZP`, `CONNECTOR_SHARED_SECRET`, `DATABASE_URL`, `SOCIAL_ACCOUNTS_FILE`, `SOCIAL_IDENTITY_BINDINGS_FILE`). Detalle, códigos de error y JWT contract: **`docs/social-api.md`**; superficies registradas: `http.social-api.*` en `CONTRACTS.yaml`. Encendido = PR del operador tras el PR2 de SC-705 y el mapper Audience de SC-1198 historia 0. Los QR de la casa (`/api/v1/auth/qr`, `/api/v1/me` de los conectores) son superficie DISTINTA e intacta (diseño D6).

## Reenganche NATS + backfill acotado al reconectar (INFRA-112)

Tres piezas, todas por GitOps (rama `feat/infra-112-p6-integration` → PR → `deploy/prod` → ArgoCD):

- **Backfill acotado (whatsapp-web)**: cuando la sesión Baileys se reengancha tras una caída, el conector
  pide el histórico SOLO de la ventana perdida: `historyBackfillRequestedUntil` = ahora −
  `WA_RECONNECT_BACKFILL_WINDOW_HOURS` (prod: `6`), con tope duro de `WA_RECONNECT_BACKFILL_MAX_MESSAGES`
  mensajes (prod: `500`), newer-first. Se ingresa con el marcador que ya existía:
  `source=baileys_history_sync` (`connectors/whatsapp-web/src/baileys-client.ts`) — nunca un marcador nuevo.
  Los dos env se declaran en el registro de cuentas `k8s/base/social-accounts.json` (bloque `deploy.env`
  de las tres cuentas WhatsApp) y viajan a los pods vía `k8s/base/generated/connectors.yaml`
  (renderizado por `scripts/render-connectors.py`; CI falla si está obsoleto con `--check`).
  `WA_HISTORY_SYNC_ON_LOGIN` global sigue SIN activarse: todo histórico queda acotado por estos dos env.
  Test: `src/reconnect-backfill.test.ts` (afirma que `fetchMessageHistory` no se invoca por encima del tope).
- **Retén NATS acotado (whatsapp-web + instagram)**: si el publish contra NATS falla, los publishers
  (`connectors/whatsapp-web/src/events/publisher.ts`, `connectors/instagram/src/publisher.ts`) ya NO
  descartan el evento: lo guardan en una cola con tope de entradas y antigüedad y lo republica al
  reengancharse, sin duplicar por id de evento, con backoff `NATS_RECONNECT_BASE_MS`→`NATS_RECONNECT_MAX_MS`
  (2s→30s default). Contadores publicados/recibidos para medir la pérdida.
  Tests: `src/events/publisher.retention.test.ts` y `src/events/publisher.live.test.ts` (whatsapp-web),
  `src/publisher.retention.test.ts` (instagram).
- **Reenganche NATS (telegram)**: el publisher de telegram reintenta `connect()` con el mismo backoff en
  vez de propagar el error; `main.ts` ya no muere con un fallo de NATS en runtime (antes: CrashLoop).
  Test: `connectors/telegram/src/events/publisher.test.ts`.

Subjects NATS y formato de evento: INTACTOS (los consumen mcp-server/telegram-sync/brain-ingest).

## Release Production (norma del tronco, 2026-09-29)

El workflow `release.yml` corre con `workflow_dispatch` y usa `version = image_tag || github.ref_name`.
El tronco `main` **no puede** despacharse sin `image_tag` explícito: intentarlo deja el tag Harbor
inmutable `whatsappmcp-*:main` apuntando al primer digest que lo publicó (medido 29-09: `main` →
`d1bb1da3`, run 36511436174; los builds de los runs 36517053696/36519841473 generan otros digests y
mueren en `Harbor immutable tag collision: main is not attached to …`). Los tags `sha-<commit>`
también colisionan si un run anterior publicó el mismo commit con otro digest (caché de capas: mismo
commit, distinto byte-code).

- **Norma**: despachar SIEMPRE con `image_tag` (secuencial, p. ej. `v1.3.61`), o desde `deploy/prod`
  (el patrón histórico: runs 36477444351/36135670213 verdes).
- **Un run fallido quema tags**: publica `sha-<commit>` y a veces el `image_tag` de algunas imágenes antes
  de morir. Reintentar sobre el mismo commit choca con `sha-<commit>` (medido 30-09: runs 36699101771 →
  36701685011 sobre `aa547dc`). Para reintentar hace falta un commit nuevo en `deploy/prod` (vía PR) y un
  `image_tag` que nadie haya usado; mira antes qué tags publicaron los runs fallidos
  (`gh run view <id> --log | grep image_tag`), también los de otras sesiones.
- La promoción de la rama deploy (`reusable-manifest-release.yml`, push `HEAD:deploy/prod
  --force-with-lease`) exige que main sea ancestro de deploy/prod: tras el merge #104 lo es; si vuelven
  a divergir (p. ej. un hotfix directo sobre deploy/prod), reconciliar main ANTES de soltar desde main.
- El `main` de Harbor es un cadáver inmutable: no borrarlo (protección del registro); ignorarlo como
  referencia de despliegue — el overlay prod fija imágenes por digest, nunca por tag `main`.

## Estructura

Tras el refactor del 2026-05-07 (commit `6791fae`), todo bajo carpetas dedicadas:
- `connectors/{whatsapp-web,telegram,telegram-sync,instagram}/` — `whatsapp-web` (Baileys) sirve ambas cuentas de WhatsApp vía dos Deployments
- `mcp-server/`, `shared/`

## Conectores (estado 2026-05-08)

| Conector | Puerto | Estado | Notas |
|----------|--------|--------|-------|
| WhatsApp Web personal | 3001 | ✅ | Baileys, número personal; sesión en PVC `whatsapp-session-data` |
| WhatsApp Web professional | 3001 | ✅ | Baileys, número de negocio; deploy `whatsapp-connector-professional`, PVC `whatsapp-session-data-professional` |
| WhatsApp Web leila | 3001 | 🟡 desplegada, sin emparejar | Baileys, número de Leila (SC-1144 fase 2); deploy `whatsapp-connector-leila`, PVC `whatsapp-session-data-leila` (arranca vacío → pedirá QR por LAN en `whatsapp-leila.lan.e-dani.com/qr/page`) |
| Telegram | 3002 | ✅ | gramjs (send + realtime); personal + professional |
| Telegram-sync | 3080 | ✅ | telethon, ingestion → Postgres |
| Instagram | 3003 | ✅ 2 cuentas | skirmshop (~7.135), barbelpapis (~14.949) |
| MCP server (interno) | 3000 | ✅ | |
| MCP SSE (público) | 3010 | ✅ | Bearer token |
| social-api (SC-1197) | 3020 | ⏸ inerte (`replicas: 0`, `SOCIAL_PAIRING_API=off`) | imagen mcp-server; única cara de la API de emparejamientos por `sub`, solo in-cluster desde ns `messages` / `app: dgx-messages` (netpol `whatsapp-mcp-allow-messages-social-api`), sin IngressRoute; verifica el JWT |
| whatsapp-pairing (SC-1197) | 3001 | ⏸ inerte (`replicas: 0`) | imagen whatsapp-connector; pool baileys por `sub`, `Recreate`, `SESSION_PATH` en `emptyDir` de memoria (persistencia solo en el credential store); solo lo alcanza social-api |
| telegram-pairing (SC-1197) | 3002 | ⏸ inerte (`replicas: 0`) | imagen telegram-connector; pool mtcute por `sub`, `Recreate`, `emptyDir` de memoria; solo lo alcanza social-api |

> **WhatsApp Cloud API eliminado (2026-05-27).** Se sustituyó por una segunda cuenta Baileys. Motivo: coste cero (no Meta) y poder contestar a mano desde el móvil.

## Instagram — DMs bloqueados, resto OK

Estado del conector (puerto 3003, ambas cuentas conectadas):

| Capacidad | Estado | Nota |
|---|---|---|
| Profile / followers | ✅ | |
| Media / posts / reels read | ✅ | |
| Comments read + reply | ✅ | |
| Stories read | ✅ | |
| Publish image / carousel / reel / story | ✅ | Implementado en `instagram-api.ts` |
| Media insights | ✅ | impressions / reach / engagement / saved |
| **DMs (read + send)** | ❌ | Graph API devuelve `data:[]` por permisos |

**Causa del bloqueo de DMs:** los tokens actuales en `.env` (`INSTAGRAM_SKIRMSHOP_ACCESS_TOKEN`, `INSTAGRAM_BARBELPAPIS_ACCESS_TOKEN`) vienen de la app **Skirmshop conector MCP** (`1268684188569802`), que solo tiene `email`+`public_profile`. Sin `instagram_business_manage_messages` Meta no expone conversaciones.

**Solución:** migrar a la app **Skirmshop marketing manager** (`1431837657952463`, Instagram app ID `1869504556900523`), que ya tiene el producto Instagram + Instagram Login.

### Checklist para desbloquear DMs

1. **App Meta — Skirmshop marketing manager (`1431837657952463`)**
   - [ ] Configurar webhook en producto Instagram (URL: `https://<dominio>/api/v1/<account>/webhook`, verify token = `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` del `.env`)
   - [ ] Suscribirse a eventos: `messages`, `messaging_postbacks`, `comments`
2. **Permisos**
   - [ ] `instagram_business_manage_messages` (necesita Advanced Access)
   - [ ] `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`
   - [ ] Añadir `skirmshopes` y `barbelpapis` como **roles → testers** durante App Review
3. **Tokens**
   - [ ] Generar long-lived user token (60d) vía Instagram Login para cada cuenta
   - [ ] Intercambiar por business token para `INSTAGRAM_<ACCOUNT>_ACCESS_TOKEN`
   - [ ] Actualizar `FACEBOOK_APP_ID` y `FACEBOOK_APP_SECRET` con los de la marketing manager
4. **Despliegue**
   - [ ] Actualizar `.env` (`/home/dibanez/mcp-socialmedia/.env`)
   - [ ] `docker compose restart instagram-connector`
   - [ ] Verificar: `curl http://localhost:3003/api/v1/skirmshop/conversations` ya no debería devolver `data:[]`
5. **App Review (producción real, no solo testers)**
   - [ ] Solicitar Advanced Access para `instagram_business_manage_messages`
   - [ ] Grabar screencast del flujo end-to-end
   - [ ] Pasar app de Development → Live

## LLM

Código migrado a **LiteLLM** (commit `07fa1db`). Ollama **eliminado del proyecto** (2026-04-19):
- Servicio, volumen, imagen, env vars y `config/ollama/` quitados
- Proxy LiteLLM local: container `litellm-router` en puerto 4000
- Env vars activos: `LLM_BASE_URL`, `LLM_CHAT_MODEL`

`README.md` y `DEPLOYMENT.md` reescritos el 2026-05-08 con la realidad actual.

## Comandos útiles

```bash
# Ver estado de todos los conectores
for p in 3002 3003 3010 3080 3090; do curl -s http://localhost:$p/health; echo; done
curl -s http://localhost:3001/status   # WhatsApp personal
curl -s http://localhost:3004/status   # WhatsApp Cloud (diferido)

# Contar mensajes por plataforma
docker exec whatsappmcp-postgres-1 psql -U whatsappmcp -d whatsappmcp \
  -c "select platform, count(*) from messages group by platform;"

# Logs en vivo
docker logs -f whatsappmcp-whatsapp-connector-1
docker logs -f telegram-sync
```

## Pendientes técnicos

- **App Instagram "Skirmshop marketing manager"** — desbloquear DMs (checklist arriba)
- **WhatsApp Cloud** — pendiente de teléfono físico
- **Limpiar `deploy/docker-compose.{lab,prod,base,ollama,whatsapp,telegram,mcp-server}.yml`** y `scripts/setup-ollama.sh` (legacy del modelo lab/prod, ya no se usan; el activo es `docker-compose.yml` + `docker-compose.override.yml`)
- **Quitar `version: '3.8'`** del `docker-compose.yml` si aparece (obsoleto en Compose v2)
