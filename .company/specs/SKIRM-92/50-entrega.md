Rol: developer · Fecha: 2026-10-07 · Sesión: 72ef8cdc-a0d0-46db-800f-2db49852df7f · Estado: LISTO

# SKIRM-92 P1 — Entrega

Pull request: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/224 (rama `fix/skirm-92-outbound-history-known-contact`, contra `deploy/prod`). Tres commits: el test en rojo (`0552d25`), el arreglo con contrato y documentación (`742d7ab`) y la nota de cambio con esta entrega.

## Qué se hizo

- `connectors/whatsapp-web/src/chat-state.ts`: `hasInboundHistory` y el nuevo `hasOutboundHistory` comparten `hasHistory(chatIds, kind)`. La dirección sale del mapa constante `HISTORY_FILTER` (enmienda E2), no de un parámetro `$n`. OUTBOUND lleva `status IS DISTINCT FROM 'failed'`.
- `connectors/whatsapp-web/src/baileys-client.ts`: `knownDirectContactEvidence` devuelve también `'outbound_history'`, consultando el seam `directOutboundHistory` tras el INBOUND. El aviso del `catch` pasa a `history lookup failed`. Comentarios de `guardDirectSend` y de la evidencia al día. `guardDirectSend` y las nueve rutas de envío no se han tocado.
- `CONTRACTS.yaml` (E1): frase aditiva en el `note` de `http.whatsapp-connector.messages-forward.v1`; commit con `Contract-Change: migrate http.whatsapp-connector.messages-forward.v1`. `contracts/socialmedia-tools.json` intacto.
- `ARCHITECTURE.md` (E4): fila nueva en el apartado 4, una línea en el 8, última verificación `9b785b4`.
- `direct-send-guard.test.ts` (E3): 33 casos (18 antes). Ocho fallaban antes del arreglo.
- Una refactorización fuera del plan, forzada por el check `duplicados`: `hasValidToken` de `prepareDirectPrivacyToken` llama ahora a `readDirectPrivacyTokenState`, que contenía el mismo cuerpo. Sin ella, editar el comentario de `guardDirectSend` hacía que un clon que ya estaba en el tronco contara como nuevo. Mismo comportamiento.

## Cómo verificarlo

```
pnpm --filter @mcp-socialmedia/connector test   -> tests 538, pass 537, fail 0, skipped 1 (LIVE de NATS, pide INFRA290_LIVE=1)
npx tsx --test src/direct-send-guard.test.ts    -> tests 33, pass 33, fail 0
tsc --noEmit -p connectors/whatsapp-web         -> sin errores
python3 scripts/render-connectors.py --check    -> ok
check-contracts.py sobre el rango de la rama    -> OK (93 entradas)
company-duplicados --base origin/deploy/prod    -> Sin duplicación nueva
```

Producción (criterio 6, de `qa`): tras el despliegue, `social_send_message` por `personal` al chat `138942326272106@lid` y a `34626034137`, con las dos formas (R-C). Id de mensaje devuelto, ack `sent`, sin 403, y en `kubectl logs deploy/whatsapp-connector -n whatsapp-mcp` la línea `known contact ... evidence=outbound_history`. Antes de desplegar, leer con `social_list_messages` que las filas fromMe del chat existen en la conversación del LID.

## Checklist de 00-spec.md

- [x] 1. Un 1:1 sin tctoken, token_record ni INBOUND, con un OUTBOUND no fallido, se envía sin `prepareDirectPrivacyToken` y el log dice `evidence=outbound_history` (tests de texto por LID y por PN).
- [x] 2. Un OUTBOUND fallido no cuenta (SQL con `status IS DISTINCT FROM 'failed'`, y el caso de los seams reales con la BD sustituida); el primer contacto real sigue rechazado con 403 `account_restricted` antes de tocar la red (los "never contacted" existentes, sin tocar, y uno nuevo).
- [x] 3. Todas las rutas 1:1 pasan por el mismo guard: poll, event, contact card, voice y forward con evidencia OUTBOUND; ninguna ruta tocada.
- [x] 4. Un fallo de la consulta OUTBOUND cuenta como sin historial: rechazado, el preflight lo intenta.
- [x] 5. Con `ingest = false` no se consulta ni INBOUND ni OUTBOUND.
- [ ] 6. Verificación en producción: pendiente del despliegue, la hace `qa`.

## Reutilizado

Usado del código existente:
- `connectors/whatsapp-web/src/chat-state.ts`: `resolveCanonicalConversation`, `externalIdCandidates`, `MAX_MERGE_HOPS` y la CTE `twin` de `hasInboundHistory`, ahora cuerpo de `hasHistory`. No hay SQL de resolución nuevo.
- `connectors/whatsapp-web/src/baileys-client.ts`: `knownDirectContactEvidence`, el seam `directInboundHistory` como molde de `directOutboundHistory`, `guardDirectSend` y sus nueve llamadas, `readDirectPrivacyTokenState` (reutilizada para quitar el clon de `hasValidToken`).
- `connectors/whatsapp-web/src/direct-send-guard.test.ts`: `stubPool`, `keyStore`, `makeClient`, `restricted`, el arreglo `otherPaths`.

Buscado:
- `rg -n "hasInboundHistory|directInboundHistory|knownDirectContactEvidence|guardDirectSend" connectors/whatsapp-web/src`
- `rg -n "direction = 'OUTBOUND'|status = 'failed'|setMessageStatus" connectors/whatsapp-web/src`
- `rg -n "status" mcp-server/src/infrastructure/database/migrations` (la tabla `messages` es compartida y ninguna migración del repo define `status`; el uso sobre `messages` está en `db-writer.ts` `setMessageStatus`, que hace `UPDATE messages SET status = ...`)
- `company-duplicados --base origin/deploy/prod` antes y después.

Escrito nuevo, y por qué:
- `HISTORY_FILTER`, `hasHistory`, `hasOutboundHistory` y `directOutboundHistory`: nada cubre el historial saliente. Es la forma que fijó la nota del architect.
- Tests nuevos en `direct-send-guard.test.ts`, incluido el ayudante `withOutbound` (la firma de `makeClient` se queda como estaba: tocar esa línea entraba en un clon ya existente con `privacy-tokens.test.ts` y el check `duplicados` lo contaba como nuevo).
- No construido, como pedía el plan: marcador conector frente a teléfono, columna o migración, flag de entorno, ruta o tool nuevos.

## R-A, riesgo que queda abierto

La cifra pedida por el architect (conversaciones 1:1 con OUTBOUND no fallido y sin INBOUND, por cuenta, antes y después del 30-09) no se ha podido medir: el acceso de lectura a la BD (`kubectl exec` al pod de postgres) lo deniega la política del rol developer. La consulta de solo lectura, sin probar, está en la descripción de la PR. Pasa a `qa` o a quien pueda leer la BD. Si la clase es grande en `professional`, la salida que apunta el architect es acotar con `whatsapp_message_payloads.source`; no se hace aquí.

También anotados en la PR: R-B (carrera entre un ack 463 muy temprano y la fila) y R-C (PN frente a LID de un contacto recién creado).

## Documento que refleja el cambio

`ARCHITECTURE.md` (apartados 4 y 8) y el `note` de `http.whatsapp-connector.messages-forward.v1` en `CONTRACTS.yaml`. La nota de cambio de cuatro líneas va en `.company/changes/skirm-92-outbound-history.md`.
