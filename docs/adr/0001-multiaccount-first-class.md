# ADR 0001 — Multicuenta de primera clase

Fecha: 2026-09-24. Estado: aceptado. Contexto: integración del fork NAS de Jordi
(fases 1–2 ya en prod: `/api/public/*` cerrado, registro de cuentas).

## Problema (medido en prod el 24-09)

| Hallazgo | Evidencia |
| --- | --- |
| La cuenta vive dentro del PK | `conversations.id` = `<jid>` en personal, `professional:<jid>` en el resto; 805k mensajes, 2.588 conversaciones |
| Instagram colgado de namespaces de WhatsApp | `skirmshop` → `professional`, `barbelpapis` → `personal` |
| Contacto duplicado por identidad | 118 conversaciones `@lid` con gemela por número (70 personal, 48 professional), probado con `metadata.senderPnE164` |
| `wa_chat_id` sobrecargado | se usa como almacén LID→número (`persistProfessionalLidPhoneMapping`); 26 valores repetidos entre conversaciones |
| Política atada a un nombre | puerta cold-send con `'professional'` literal en SQL |
| Conectores copiados a mano | 3 Deployments WhatsApp + 2 Telegram casi idénticos |
| Consumidores externos parsean el PK | dgx-messages, dashboard dgx-infra, synapse, skirmshop-brain-v2, skirmshop-labels, auto-reply-worker |

## Opciones evaluadas

1. **Adoptar un gateway externo** (Evolution API / WAHA multi-sesión, Chatwoot como bandeja).
   Resuelve multi-sesión de WhatsApp, pero no Telegram con cuenta de usuario (MTProto) ni
   Instagram Graph, rompe el contrato MCP (34 tools) y la base unificada que alimenta brain/RAG.
   **Descartada**: cambiaría el transporte, no el modelo de datos, que es donde está el problema.
2. **Reescribir los PK** a `(account_id, provider_id)` sin prefijos (big-bang).
   Correcto en abstracto, pero reescribe 805k PKs + FKs (`whatsapp_message_keys`, `attachments`
   por bigint, `draft_replies`…) y rompe a la vez a los 6 consumidores externos.
   **Descartada**: máximo riesgo sin ganancia funcional frente a la opción 3.
3. **Claves naturales de primera clase + IDs opacos (expand/contract)**. **Elegida.**
   - `id` se queda como está pero pasa a ser **opaco**: nadie nuevo lo parsea.
   - Cada fila lleva `account_id` (FK a `social_accounts`) y `external_id` (id dentro de la
     cuenta), con `UNIQUE (account_id, external_id)`.
   - Un trigger rellena esas columnas para **todos** los escritores (conectores, MCP, dashboard,
     labels) sin tocarlos; los lectores migran a su ritmo porque los ids antiguos siguen valiendo.

## Decisión

1. **Cuentas**: tabla `social_accounts` (`<canal>:<cuenta>`) sincronizada desde el registro
   (`k8s/base/social-accounts.json`). `account_id` + `external_id` en conversations, messages y
   participants; backfill por lotes; índices únicos compuestos creados `CONCURRENTLY`.
2. **Identidad de contacto**: `social_contact_aliases (account_id, alias → canonical)`. Canónico =
   el `@lid` (lo que el conector escribe hoy); los alias son `@s.whatsapp.net`/`@c.us`. La fusión
   mueve los mensajes al canónico y deja la conversación alias como **lápida**
   (`conversations.merged_into`) para que las FK de los escritores sigan siendo válidas; un trigger
   redirige al canónico cualquier escritura nueva sobre la lápida. Cada fusión queda en
   `social_conversation_merges` (reversible).
3. **Instagram y perfiles**: cada cuenta de Instagram es su propia `social_accounts`; "personal" /
   "profesional" pasan a ser `social_profiles` (agrupan cuentas de cualquier canal para UI y
   permisos). La columna `account` queda como **legado** para lectores antiguos.
4. **IDs opacos**: en el MCP la cuenta se obtiene de `account_id`, nunca del prefijo; las
   referencias que llegan de los tools se resuelven por `(account_id, external_id)` o por id, y
   siempre al canónico. `accountKey` solo acuña ids al escribir (compatibilidad).
5. **Políticas y despliegue por cuenta**: la puerta cold-send se parametriza por cuenta (las tablas
   003/004 ya tienen `account`); los Deployments de conector se generan desde el registro con
   un renderizador y un check de CI de "generado al día".
   Implementado en `scripts/render-connectors.py`: los parámetros por cuenta viven en el bloque
   opcional `deploy` de cada entrada del registro; salida en `k8s/base/generated/` (manifiestos +
   la proyección de runtime del registro, sin `deploy`, que es lo que monta el ConfigMap).
   *Enmienda 25-09-2026*: la puerta cold-send (`requireInboundBeforeSend`) se **elimina** por
   decisión de Dani: ningún canal bloquea el primer contacto; los envíos van directos al conector
   de la cuenta con el jid sin prefijo.

## Consecuencias

- Añadir un número = una entrada en el registro + emparejar por QR; ningún cambio de código.
- Consumidores externos: siguen funcionando; deben migrar a `account_id`/`external_id` y filtrar
  `merged_into IS NULL` (dgx-messages se migra en este mismo cambio).
- Queda para una fase posterior, opcional: acuñar ids nuevos sin prefijo, cuando ningún lector
  parsee ya el `id`.
