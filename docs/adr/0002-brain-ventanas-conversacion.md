# ADR 0002 — Conversaciones de WhatsApp y Telegram en el brain por ventanas (INFRA-364)

Estado: aceptado (30-09-2026, Dani). Sustituye a la ingesta por mensaje suelto (`brain-ingest`).

## Contexto

`brain-ingest` subía **un documento por mensaje** (`toDoc` en `mcp-server/src/jobs/brain-ingest-lib.ts`) y el
brain solo embebe `content`. Resultado: vectores de «vale», «ok» o emojis, aciertos sin la pregunta ni la
respuesta, y 584k puntos de ruido en `personal_documents` (72 % de la colección). Además, las notas de voz que se
transcriben después de entrar se perdían (el cursor por `created_at` ya las había pasado).

Datos medidos el 30-09 (`whatsappmcp`, mensajes con texto y no borrados): 787.940 mensajes en 1.254 chats
(personal/telegram 509k, personal/whatsapp 232k, professional/telegram 38k, professional/whatsapp 9k). Cortando
por 1 h de silencio salen 52.309 ventanas (p50 = 1 mensaje, p90 = 24, p99 = 245). 78 ventanas de más de 100k
caracteres concentran la mitad del texto y son casi todas de bots (solo «Synapse monitor» es el 42 %). 329k
mensajes entraron en la base más de un día tarde (history sync).

Restricciones del brain (`skirmshop-brain-v2`, tronco `main`): `push-ingest` no re-trocea mensajes, un documento
es un punto, solo se embebe `content`; el embedding trunca en silencio a 8.192 tokens y el reranker a 512; el
payload `text` se corta a 16.384 caracteres; no hay borrado por filtro.

## Decisiones de Dani

1. Ventanas **padre-hijo**: la ventana se cierra tras **1 h de silencio** en ese chat. La ventana entera se guarda
   y es lo que se devuelve; lo que se busca es su **resumen** y **trozos de 200–400 tokens con cabecera**.
2. Bots, monitorización y canales de difusión: **se indexan en ventanas, pero no pasan por el LLM ni crean
   neuronas**.
3. Las notas de voz de WhatsApp (4.577, hoy con `content` vacío) **se transcriben** antes del reindexado.
4. Se reindexa **desde cero** todo WhatsApp y Telegram de las tres cuentas.
5. LLM local con **2 peticiones en paralelo**; después, incremental cada 30 min.

La literatura respalda el padre-hijo frente a «ventanas del tamaño máximo»: la recuperación empeora con trozos de
más de unos cientos de tokens aunque el modelo admita 8k (Chroma; arXiv 2505.21700; LongEmbed 2404.12096), y
Anthropic recomienda trozos de cientos de tokens con contexto antepuesto (Contextual Retrieval, −49 % de fallos).

## 1. La ventana

- **Chat**: `(account, platform, conversation_id)`, con `conversation_id = COALESCE(conversations.merged_into, id)`.
- **Mensajes**: `NOT is_deleted`, `btrim(content) <> ''`, ordenados por `(wa_timestamp, id)`.
- **Corte**: ventana nueva cuando el hueco con el mensaje anterior del mismo chat supera **3.600 s**.
- **Tope**: 16.000 caracteres de transcript. Si se supera, se parte en el mayor hueco temporal que deje la parte
  entre 8.000 y 16.000 caracteres; si no hay hueco, en el límite de mensaje. Un mensaje de más de 16.000
  caracteres se corta por frases. Las partes llevan `:p1`, `:p2`…
- **Id**: `window_key = {platform}:{account}:{conversation_id}:{epoch_s(wa_timestamp del primer mensaje)}` y
  `source_id = win:{window_key}` (partes: `win:{window_key}:p{n}`). Si un mensaje tardío cambia el primer mensaje,
  cambia el id: la ventana vieja se borra del brain y se sube la nueva (ver §6).

## 2. Formato

Cabecera, una línea:

```
[WhatsApp · grupo «Reforma casa» · Ana, Luis, Dani · 2026-03-14 18:02–19:47]
```

- Plataforma (`WhatsApp`/`Telegram`), `grupo`/`chat`/`canal` y nombre del chat.
- Participantes que hablan en la ventana (máx. 8, luego `+N`). El remitente sale de `participants.name`, luego
  `push_name`, luego el número; los `OUTBOUND` son `Dani` (o el nombre de la cuenta: `Skirmshop`, `Leila`).
- Rango en hora de `Europe/Madrid`.

Transcript, un mensaje por línea, sin mezclar autores:

```
18:04 Luis: ¿mañana a las 5 en la obra?
18:05 Dani [voz]: sí, llevo las muestras de azulejo
18:07 Ana [reenviado]: …
— 2026-03-15 —
00:12 Luis: …
```

## 3. Documentos que se suben al brain

Por `POST /instances/{instance}/push-ingest` (sin cambiar la API), `adapter` = `whatsapp` | `telegram`,
instancia según el registro de cuentas (`personal`, `leila` → `personal`; `professional` → `skirmshop`).

**Padre `conversation_window`** (uno por ventana o parte):

- `content` (lo que se embebe): cabecera + resumen del LLM si existe; si no, cabecera + los primeros ~1.500
  caracteres del transcript.
- `metadata`: `type: conversation_window`, `platform`, `account`, `conversation_id`, `conversation_name`,
  `conv_kind` (`chat` | `group` | `channel` | `bot`), `window_key`, `part`, `start_ts`, `end_ts`, `observed_at`
  (= `end_ts`, ISO 8601), `message_count`, `participants[]`, `message_ids[]` (`wa_message_id`), `transcript`
  (completo, ≤ 16.000), `content_hash`, `llm_status` (`pending` | `done` | `skipped` | `failed`), `summary` y
  `extraction` (el JSON de §5) cuando `llm_status = done`.

**Hijos `conversation_chunk`** (solo en ventanas no triviales):

- 3–8 mensajes seguidos, objetivo 200–400 tokens (≈ 800–1.600 caracteres), sin partir mensajes salvo los que
  superen 1.600 caracteres (por frases). Solape de 1 mensaje entre hijos consecutivos.
- `content`: cabecera + sus líneas.
- `source_id`: `{source_id del padre}#c{n}`.
- `metadata`: `type: conversation_chunk`, `window_source_id`, `chunk_index`, `platform`, `account`,
  `conversation_id`, `conversation_name`, `conv_kind`, `observed_at`, `message_ids[]`.

**Ventana trivial**: menos de 4 mensajes o menos de 160 caracteres de texto útil (sin contar emojis,
reacciones, «ok», «vale»…). Se sube solo el padre, sin hijos, con `llm_status: skipped`. Así el recuento de
mensajes en ventanas cuadra con Postgres.

## 4. Recuperación small-to-big (brain)

- Los aciertos `conversation_chunk` se agrupan por `window_source_id` y se devuelven como **la ventana padre**
  (cabecera + transcript), con los fragmentos que acertaron marcados. Puntuación = la mejor de sus hijos y del
  propio padre.
- El reranker puntúa el hijo (cabe en sus 512 tokens) o el `content` del padre, nunca el transcript entero.

## 5. Extracción con el LLM local

- Modelo `tooling` (LiteLLM → residente de los Sparks), clave de **baja prioridad** (tipo `hermes-batch`),
  `temperature: 0`, `enable_thinking: false`, `response_format: json_object`, `max_tokens: 1200`.
- **Concurrencia 2** en el reindexado y en el incremental. Timeout 240 s, 2 reintentos; si falla,
  `llm_status: failed` y se reintenta en la pasada siguiente.
- **No pasan por el LLM**: ventanas triviales y `conv_kind` `channel` o `bot` (`conversations.type = 'channel'`
  más la lista de chats de bots y monitorización en `k8s/base/brain-windows-config.yaml`).
- Entrada: cabecera + transcript (≤ 16.000 caracteres) + el resumen de la ventana anterior del mismo chat como
  contexto (para resolver referencias).
- Salida (JSON, en español):

```json
{
  "summary": "≤ 120 palabras",
  "topics": ["≤ 6"],
  "entities": [{"name": "", "type": "persona|lugar|organizacion|proyecto|producto|servicio|evento|importe|fecha", "aliases": []}],
  "facts": [""],
  "decisions": [""],
  "action_items": [{"owner": "", "task": "", "due": ""}],
  "sentiment": "positivo|neutro|negativo|mixto",
  "trivial": false
}
```

- Tras la extracción, el padre se vuelve a subir con `content` = cabecera + `summary` y con `extraction`. Si el
  LLM dice `trivial: true`, no se crean neuronas.
- Checkpoint idempotente: si el hash de la entrada no cambia, no se vuelve a llamar al LLM.

## 6. Estado en Postgres (`whatsappmcp`, migración nueva)

- `messages.updated_at timestamptz NOT NULL DEFAULT now()`, con trigger que lo actualiza en todo `UPDATE` de
  `content`, `is_deleted` o `is_edited`, e índice `(account, updated_at, id)`. Así el incremental ve mensajes
  nuevos, tardíos, editados, borrados y notas de voz transcritas después. (En PostgreSQL ≥ 11 añadir la columna
  con ese `DEFAULT` no reescribe la tabla.)
- `brain_windows`: `source_id` PK, `account`, `platform`, `conversation_id`, `window_key`, `part`, `start_ts`,
  `end_ts`, `message_count`, `first_message_id`, `last_message_id`, `conv_kind`, `content_hash`, `pushed_hash`,
  `pushed_at`, `chunk_count`, `llm_status`, `llm_input_hash`, `llm_done_at`, `llm_error`.
- `brain_windows_cursor`: `(account)` → `last_updated_at`, `last_id`.

## 7. Pasada incremental (CronJob `brain-windows`, cada 30 min)

1. Lee los mensajes con `updated_at` posterior al cursor y saca los chats y rangos de tiempo afectados.
2. Recalcula las ventanas de cada chat en `[min − 1 h, max + 1 h]`, ampliado a ventanas completas.
3. Compara con `brain_windows`: borra del brain las que desaparecen (padre e hijos, por `delete-document`) y sube
   las nuevas o cambiadas (por `content_hash`).
4. Una ventana cuyo último mensaje tiene menos de 1 h se sube como provisional (`llm_status: pending`); el LLM
   solo corre sobre ventanas **cerradas**.
5. Pasa el LLM por las ventanas cerradas pendientes (tope por pasada, 2 en paralelo) y vuelve a subir los padres.

Sustituye al CronJob `brain-ingest` (pausado desde el 30-09, #144), que se retira.

## 8. Neuronas y aprendizaje hebbiano (brain)

- Cada ventana con `extraction` produce un **knowledge packet** (`packet_id` = `source_id` + `content_hash`):
  nodos de concepto canónicos para temas y entidades (minúsculas, sin tildes ni determinantes, con alias),
  `MENTIONS` de la ventana a cada concepto y `CO_OCCURS` entre cada par de conceptos de la ventana (máx. 12
  conceptos por ventana). Reutiliza `knowledge_packet.py` y el merge de `falkordb.py`, idempotente por
  `packet_id`.
- Contadores: `activation_count` en el nodo (c_i), `co_activations` en la arista (c_ij) y un contador de
  ventanas por instancia (N).
- **Refuerzo**: `strength ← strength + η·(1 − strength)`, η = 0,1 (ya implementado).
- **Decaimiento**: `strength_eff = strength · λ^(días desde last_activated_at)`, λ = 0,995 por día; se aplica
  al leer y un job diario lo consolida.
- **Asociación** (contra los «hubs» tipo «Dani» o «mañana»):
  `NPMI = ln(p_ij / (p_i · p_j)) / −ln(p_ij)`, con `p = c / N`; `peso = clip(NPMI, 0, 1) · strength_eff`. Las
  aristas con `c_ij < 2` no cuentan como asociación.
- **Poda** (job diario): `peso < 0,05` y sin refuerzo en 180 días; como mucho 64 aristas `CO_OCCURS` por
  neurona, las de más peso.
- **Lectores**: la API de grafo (`neurons`, `connections`, `connections/top`) y el MCP devuelven `CO_OCCURS` con
  `strength`, `co_activations`, `npmi` y `weight`, y `activation_count` en los nodos.
- En `personal`, `BRAIN_SKIP_PERSONAL_MESSAGE_PUSH_GRAPH` sigue saltando el grafo por mensaje; los packets de
  ventana sí se escriben.
- Fuera de este alcance: refuerzo por recuperación conjunta (dos neuronas que salen juntas en una búsqueda).

## 9. Reindexado inicial

- **Fase 0**: transcripción de las notas de voz de WhatsApp.
- **Fase 1, purga** (script en el repo del brain, primero en seco con recuento):
  - Qdrant: puntos `type = message` con `adapter` ∈ {`whatsapp`, `telegram`, `instagram`} en
    `personal_documents` (~584k) y `skirmshop_documents` (~82k). Se filtra por `adapter`, no por `source`.
  - Grafo: los `ConvDay`/`Event` derivados de mensajes en `personal_v2` (~801k) y los `Message` de
    WhatsApp/Telegram en `skirmshop_v2`. El job diario `personal-graph-enrichment` se adapta para no volver a
    crearlos por mensaje.
- **Fase 2**: carga de todas las ventanas (padres e hijos) sin LLM. La búsqueda funciona desde aquí.
- **Fase 3**: el LLM va detrás, de lo más reciente a lo más antiguo, 2 en paralelo, y crea las neuronas.

Todo corre en el x86 (embedder GPU `bge-m3-embedding`); en los Sparks solo el LLM residente, a 2 peticiones.

## Fuera de alcance

Correo (Gmail → brain), Instagram, refuerzo por recuperación conjunta, cambiar el perfil de cómputo.

## Fuentes

- Anthropic, Contextual Retrieval — https://www.anthropic.com/news/contextual-retrieval
- Chroma, Evaluating Chunking — https://www.trychroma.com/research/evaluating-chunking
- arXiv 2505.21700 (tamaño de chunk y recall) — https://arxiv.org/abs/2505.21700
- LongEmbed — https://arxiv.org/abs/2404.12096
- BGE-M3 — https://arxiv.org/abs/2402.03216
- Zep/Graphiti — https://arxiv.org/abs/2501.13956
- Mem0 — https://arxiv.org/abs/2504.19413
- HippoRAG — https://arxiv.org/abs/2405.14831
- LightRAG — https://arxiv.org/abs/2410.05779
- A-MEM — https://arxiv.org/abs/2502.12110
- Snyk, hilos de Slack como documentos — https://snyk.io/articles/from-slack-threads-to-structured-knowledge-implementing-rag-at-snyk/
