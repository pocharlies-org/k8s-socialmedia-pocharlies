# Contrato conversation-window v1 (socialmedia → brain)

Origen: INFRA-364 `nota-architect-plan.md` §C (architect, 2026-10-01). **Normativo y transcrito sin cambios**; cambiarlo = pedir al architect (vía tech-lead). Un cambio roto es `conversation-window.v2` al lado, nunca una edición de este. Este repo no tiene `CONTRACTS.yaml`: este documento es el registro.

Artefactos: `docs/conversation-window.schema.json` (JSON Schema 2020-12 del documento de `push-ingest`: `{source_id, content, metadata}`), fixtures en `tests/fixtures/conversation_windows/` (`valid_*.json` deben validar, `invalid_*.json` deben rechazarse) y test `tests/unit/test_conversation_contract.py`. Copia vendorizada con checksum en `k8s-socialmedia-pocharlies` (`mcp-server/src/jobs/brain-windows/contract/`).

## §C. Contrato socialmedia → brain (normativo, `contract v1`)

Instancia: `instanceForAccount` (`personal`|`leila` → `personal`; `professional` → `skirmshop`). Colección: `documents_collection(instance)`.

**Ids.** `window_id = cw:{platform}:{account}:{conversation_id}:{first_msg_id}`, con `first_msg_id` = `messages.id` del primer mensaje ordenando por `(wa_timestamp, id)`. Puntos: `window_id` (ventana), `window_id#c{n}` (chunks, n desde 0), `window_id#kp` (paquete). Prefijo `cw:` nuevo (no choca con `wa:`/`tg:`/`ig:`).

| type | adapter | vector | grafo | `content` (lo embebido) |
|---|---|---|---|---|
| `conversation_window` | `conversation` | sí | no | resumen LLM si `llm_status=done`; si no, cabecera + primeros ≤1.500 chars |
| `conversation_chunk` | `conversation` | sí | no | cabecera de una línea + 200–400 tokens (~800–1.600 chars) en frontera de mensaje; solape = último mensaje anterior (≤200 chars) |
| `conversation_packet` | `knowledge_packet` | sí | **sí** | `Temas: a, b. Entidades: x, y.` (distinto del resumen, por el dedupe por texto de `hybrid._points_to_nodes`) |

**Metadata común:** `type`, `window_id`, `source: "conversation"` (**obligatorio**: así `MessagingExtractor`, que actúa con `source in {whatsapp,telegram,instagram}`, no crea un `Message` por chunk; en el packet `source: "knowledge_packet"`), `source_system` = plataforma, `platform`, `account`, `conversation_id`, `conversation_name`, `is_group`, `kind` (`chat|bot|broadcast`), `start_ts`, `end_ts` (ISO UTC), `wa_timestamp` (= `start_ts`), `day` (YYYY-MM-DD UTC de `start_ts`), `message_count`, `contract_version: 1`.
**Solo ventana:** `window_text` (cabecera + ventana completa, **≤16.384 chars**, lo que se devuelve), `message_ids` (strings), `participants` (≤50), `window_hash` (sha256 de `(id, content)` ordenados), `llm_status` (`pending|done|skipped`), `truncated_by_size`, `patterns` (≤3).
**Solo chunk:** `chunk_index`, `chunk_count`, `msg_id_first`, `msg_id_last`.
**Solo packet:** `kp_kind: "summary"`, `kp_source_id: window_id`, `kp_source_type: "conversation_window"`, `kp_source_label: "ConvDay"` (nuevo, opcional, por defecto `Source`; ver P3-e), `kp_title`, `kp_ts` (= `end_ts`), `kp_date`, `kp_participant_count`, `kp_permalinks: []`, `kp_sensitivity: "personal"`, `kp_topics` (kebab ASCII ≤40), `kp_entities` (`{type, name}`, sin `slug`); ≤12 conceptos en total (`MAX_CONCEPTS_FOR_PAIRS`). **Sin puntos `kp_kind: "assertion"` en v1**: el gardener de `personal` los consumiría como candidatos (`consolidation/experts.py:_extract_knowledge_packets`).

**Reglas**
1. Una ventana se envía **entera en una petición** por adapter: ventana + todos sus chunks (adapter `conversation`); el packet en otra, solo cuando cambia la extracción.
2. Mensaje tardío: se recalcula; mismo `window_id` ⇒ upsert y el brain barre por `window_id` los chunks sobrantes (P3-b). Si cambia el primer mensaje, cambia el `window_id`: el builder llama `POST /instances/{id}/delete-window` (P3-c) con el viejo y empuja el nuevo.
3. Cortes: orden `(wa_timestamp, id)`; corte si el hueco con el anterior es **> 3.600 s** (3.600 no corta); corte por tamaño antes de superar 16.000 chars de líneas (+ cabecera ≤16.384); un mensaje >16.000 chars se trocea por párrafos (`truncated_by_size=true`). Línea: `HH:MM Nombre: texto`; nota de voz `HH:MM Nombre: 🎙 texto`; respuesta en la misma ventana `(resp. a Nombre)`.
4. Cuentan `is_deleted=false AND btrim(content) <> ''` (la medida de Dani: 787.940). Solo-media sin texto queda fuera en v1 y se declara.
5. Validación en el brain (422; el builder lo trata como veneno: registra y sigue): `source_id` empieza por `cw:`; `type` válido; `window_text` ≤16.384; `content` no vacío; `window_id` presente; `contract_version==1`.
6. Bots/monitorización/difusión (`kind != chat`): ventanas y chunks sí, **sin LLM ni packet**. Lista en SM `mcp-server/src/jobs/brain-windows/chat-kinds.json` (`{conversation_id: "bot"|"broadcast"}`), generada por P1b con informe de candidatos y **confirmada por el tech-lead antes de P6**.
