# Brain · ventanas de conversación — documento de diseño (INFRA-367 / P1b)

Épica INFRA-364. Este documento **explica y fija los números** del contrato
`conversation-window v1` (PR #147, `mcp-server/src/jobs/brain-windows/contract/`). **No lo modifica**: si una
regla de aquí choca con el contrato, manda el contrato y se pide cambio al architect (un cambio roto sería
`conversation-window.v2` al lado). Los puntos donde el contrato deja margen y aquí se elige van marcados
**[interpretación]** para que el architect los confirme.

## 1. Fuentes (leídas el 2026-10-01) y qué se toma de cada una

| # | Fuente | Qué se toma |
|---|---|---|
| 1 | Anthropic, *Introducing Contextual Retrieval* — https://www.anthropic.com/news/contextual-retrieval | Cada chunk se embebe con un prefijo de contexto propio («chunk-specific explanatory context»); chunks de unos cientos de tokens. Reporta −35 % de fallos top-20 con embeddings contextuales, −49 % con BM25 contextual y −67 % con reranking. Aquí: la **cabecera de una línea** de cada chunk (chat, fecha, participantes) es ese contexto; sale de los metadatos, sin LLM, coste cero. |
| 2 | LlamaIndex, *Auto Merging Retriever* — https://developers.llamaindex.ai/python/examples/retrievers/auto_merging_retriever/ | Jerarquía grueso→fino (por defecto 2048/512/128); solo las hojas se indexan en el vector store y se recuperan por similitud; si suficientes hojas de un mismo padre aciertan, se fusionan en el padre. Aquí: hoja = `conversation_chunk`, padre = `conversation_window`; la expansión agrupa por `window_id`. |
| 3 | LangChain, `ParentDocumentRetriever` (docstring en el código) — https://github.com/langchain-ai/langchain/blob/master/libs/langchain/langchain_classic/retrievers/parent_document_retriever.py | El conflicto que motiva el patrón: trozos pequeños dan embeddings precisos, trozos grandes conservan el contexto; se indexan los pequeños y se devuelve el padre (documento entero o un chunk mayor). Aquí: justifica «busca por chunk, devuelve `window_text`» (small-to-big, P3-f). La página de docs `python.langchain.com/docs/how_to/parent_document_retriever` redirige hoy a un índice genérico; por eso se cita el código. |
| 4 | Wu et al., *LongMemEval* — https://arxiv.org/abs/2410.10813 | Benchmark de memoria a largo plazo con cinco capacidades (extracción de información, razonamiento temporal…); los sistemas existentes pierden ~30 % de precisión. Propone **descomposición de sesiones para la granularidad del valor** y **expansión de claves con hechos** para el índice. Aquí: ventana = sesión; chunks = granularidad del valor; temas/entidades del LLM = claves con hechos. Solo leí el resumen de arXiv, no el paper completo. |
| 5 | Google Analytics, *About sessions* — https://support.google.com/analytics/answer/2731565 | La sesión agrupa interacciones y termina tras **30 minutos de inactividad**, ajustable de segundos a horas. Precedente estándar de segmentar por huecos. El umbral aquí es **3.600 s** (lo fija el contrato): los chats son asíncronos y una hora cubre «te contesto en un rato». Ninguna fuente da 3.600 s como óptimo: es decisión de diseño, **calibrable con el histograma de huecos** (§8). |
| 6 | Bouma (2009), *Normalized (Pointwise) Mutual Information in Collocation Extraction* — https://svn.spraakdata.gu.se/repos/gerlof/pub/www/Docs/npmi-pfd.pdf | `npmi(x,y) = ln(p(x,y)/(p(x)p(y))) / −ln p(x,y)`. Orientación: 1 si solo aparecen juntas, 0 bajo independencia, −1 si aparecen separadas y nunca juntas. La normalización reduce, no elimina, el sesgo de baja frecuencia (§4.3). |
| 7 | Wikipedia, *Hebbian theory* — https://en.wikipedia.org/wiki/Hebbian_theory | Regla de Hebb («repeatedly or persistently takes part in firing»); la regla simple crece sin límite y es inestable; se corrige con normalización/Oja. Aquí: la saturación `lr·(1−s)` ya implementada en el brain es esa acotación (§4.1). |

## 2. Formato de ventana y sub-chunk

Fijado por el contrato §C; aquí el razonamiento.

- **Orden y corte.** Mensajes por `(wa_timestamp, id)` de una conversación (`platform, account, conversation_id`); cuentan solo
  `is_deleted=false AND btrim(content)<>''` (regla 4; la medida de Dani: 787.940). Hay corte si el hueco con el anterior es
  **estrictamente > 3.600 s**; 3.600 s exactos no cortan.
- **`window_id`** = `cw:{platform}:{account}:{conversation_id}:{first_msg_id}`. La identidad es el primer mensaje: añadir mensajes al final o
  en medio no cambia el id (upsert); solo cambia si entra uno anterior al primero.
- **Cabecera** (una línea, contexto estilo Contextual Retrieval): `{conversation_name} · {plataforma}/{cuenta} · {YYYY-MM-DD HH:MM}–{HH:MM} UTC · {n} mensajes · {participantes ≤5}`.
- **Líneas:** `HH:MM Nombre: texto`; nota de voz `HH:MM Nombre: 🎙 texto`; respuesta dentro de la ventana `HH:MM Nombre (resp. a Otro): texto`.
- **`window_text`** = cabecera + salto + líneas; **≤16.384 chars** (líneas ≤16.000 + cabecera ≤384). Es lo que devuelve la búsqueda.
- **Sub-chunks** (`window_id#c{n}`): cabecera + 800–1.600 chars (≈200–400 tokens con el estimador chars/4), cortando **en frontera de
  mensaje**; solape = último mensaje del chunk anterior, truncado a 200 chars. Un mensaje que por sí solo supera 1.600 chars se corta por
  párrafo (luego por frase) y cada trozo lleva la cabecera. `msg_id_first/last` acotan el rango; `chunk_count` se fija al terminar.
- **`content` del punto ventana:** resumen LLM (`llm_status=done`) o cabecera + primeros ≤1.500 chars (`pending`/`skipped`). Así la ventana
  es buscable desde la carga inicial, antes de la pasada LLM.
- **Packet** (`#kp`): `Temas: a, b. Entidades: x, y.` (§5). Solo `kind=chat` y `llm_status=done`.

## 3. Idempotencia y reapertura

- `window_hash` = sha256 de los pares `(id, content)` ordenados. Mismo `window_id` + mismo hash ⇒ **nada** (ni petición ni LLM).
- Mismo `window_id`, hash distinto ⇒ se reenvía la ventana entera (ventana + todos los chunks en una petición, regla 1); el brain barre por
  `window_id` los chunks que sobren (P3-b). El LLM se repite solo si cambia `llm_input_hash` (el texto que ve); el packet solo si cambia `packet_hash`.
- `window_id` que desaparece (entra un mensaje anterior al primero, o un tardío rellena el hueco y fusiona dos ventanas) ⇒
  `POST /instances/{id}/delete-window` del viejo + push del nuevo.
- **Reapertura por tardío:** el builder relee desde el `start_ts` de la última ventana conocida anterior al mensaje sucio más antiguo hasta el
  final del chat y compara contra `brain_window_state` (P4). Dos orígenes de «tardío»: `created_at` alto con `wa_timestamp` bajo
  (history sync) y voz transcrita a posteriori (`brain_window_dirty`).

## 4. Hebbiano y reglas de salto

### 4.1 Escritura (ya existe, no se cambia)
`HEBBIAN_MERGE_CYPHER` (`skirmshop-brain-v2/src/stores/falkordb.py`) con `lr = HEBBIAN_LR = 0.1`
(`src/extractors/knowledge_packet.py`): al crear, `s = lr`; al repetirse con un `packet_id` nuevo,
`s' = s + lr·(1 − s)` (satura hacia 1, nunca lo pasa); con un `packet_id` ya visto en `rel.packets`, no cambia nada.
`co_activations` y `last_activated` se actualizan igual. **Límite declarado:** `rel.packets` guarda los últimos 50 ids, así que un packet
reenviado muy tarde podría contar dos veces; por eso el packet solo se empuja cuando cambia la extracción.

### 4.2 Decaimiento en lectura (P3-d; no se reescribe ninguna arista)
`effective_strength = s · 0,5^(Δdías / 90)` con `Δdías = now − last_activated` y `half_life_days = 90` (constante en `src/config.py`).
Con s = 0,5 y sin reactivación: 90 d → 0,25; 180 d → 0,125.

### 4.3 NPMI en lectura (P3-d)
`p_ab = co/n`, `p_a = act_a/n`, `p_b = act_b/n`; `npmi = ln(p_ab/(p_a·p_b)) / −ln(p_ab)`, acotado a [−1, 1].
`co` = `co_activations` de la arista; `act_*` = `activation_count` del nodo (lo escribe `ACTIVATE_MERGE_CYPHER`); `n` = nº de `ConvDay` con
`packet:true`, cacheado 10 min. Extremos (Bouma §3.1): `co=0` ⇒ −1; `p_ab=1` ⇒ 1. Un concepto omnipresente («skirmshop») tiene `npmi` ≈ 0
aunque su fuerza sea alta; por eso se devuelve `npmi` junto a `effective_strength`. Con `co` ≤ 2 el `npmi` es ruido (el sesgo de baja
frecuencia se reduce, no desaparece): no se ordena solo por él.

### 4.4 Reglas de salto (qué ventanas no pagan LLM ni packet)
Una ventana queda `llm_status=skipped` (con motivo) y **sin packet** si se cumple cualquiera:
1. `kind != chat` (bot/difusión, §7).
2. `message_count < 3` **y** `chars < 400` (`skip: "trivial"`).
3. Todas las líneas ≤ 12 chars de texto («ok», «👍», «vale»).
4. Tras 1 reintento el LLM no devuelve JSON válido contra el esquema (`skip: "invalid_json"`).

Siguen siendo ventana + chunks (buscables). Objetivo: orden de 18–20 k ventanas elegibles; si el dry-run difiere mucho, se avisa al tech-lead.

## 5. Esquema de extracción LLM (P4)
Modelo `tooling` vía LiteLLM, `temperature 0`, máx. 2 peticiones en vuelo. Entrada: `window_text`. Salida, validada con `zod`:
```json
{ "summary": "≤600 chars, español, solo lo que dice el texto",
  "topics":   ["kebab-ascii-≤40", "… máx. 5"],
  "entities": [{"type": "Person|Org|Product|Place|Other", "name": "…"}],
  "patterns": ["≤3 regularidades o pedidos recurrentes, frases cortas"],
  "skip": null }
```
`entities` máx. 7. `skip: "trivial"` lo puede devolver el modelo (equivale a §4.4-2/3). Mapeo al contrato: `summary` → `content` de la
ventana; `topics`/`entities` → `kp_topics`/`kp_entities` (≤12 conceptos en total); `patterns` → `patterns` de la ventana. Prompt: «no
inventes; si no hay tema claro, `skip`». Sin puntos `kp_kind: "assertion"` (contrato).

## 6. Los 8 casos de fixture (resultado esperado)
Horas UTC; `m1…` en orden de `(wa_timestamp, id)`.

| # | Caso | Entrada | Resultado esperado |
|---|---|---|---|
| 1 | Hueco de 3.600 s exacto | m1 10:00:00, m2 11:00:00, m3 12:00:01 | **W1 = {m1, m2}** (hueco 3.600 no corta), **W2 = {m3}** (hueco 3.601 corta). `window_id` W1 = `…:m1`, W2 = `…:m3`. Ningún mensaje en 0 ni 2 ventanas. |
| 2 | Tardío dentro de ventana cerrada | W1 = {m1 10:00, m2 10:20, m3 10:45}, cerrada (siguiente mensaje 14:00). Llega m4 10:30 (history sync, `created_at` posterior) | Mismo `window_id` (`…:m1`), `message_count` 3→4, `window_hash` cambia ⇒ reenvío de ventana + chunks; el brain barre chunks sobrantes; LLM y packet se recalculan (cambia `llm_input_hash`). Sin `delete-window`. |
| 3 | Tardío más antiguo que el primero | W1 = {m2 10:00, m3 10:10}; llega m1 09:50 | Hueco 600 s ⇒ m1 entra en W1 y es el nuevo primero: `window_id` pasa de `…:m2` a `…:m1` ⇒ `delete-window(…:m2)` + push de `…:m1` con 3 mensajes. Variante: m1 a las 08:30 (hueco 5.400 s) crea W0 = {m1} y W1 **no cambia**. |
| 4 | Grupo sin pausa > 16 k | 120 mensajes de ~300 chars (≈36 k) sin hueco > 3.600 s | Corte por tamaño **antes** de superar 16.000 chars de líneas, en frontera de mensaje: 3 ventanas contiguas (≈16 k / ≈16 k / ≈4 k), sin mensajes repetidos, cada `window_text` ≤ 16.384, `first_msg_id` distintos, Σ`message_count` = 120. `truncated_by_size=false` en las tres **[interpretación]**: el contrato lo reserva al troceo de un mensaje (caso 8). |
| 5 | Bot | conversación marcada `"bot"` en `chat-kinds.json`, 40 mensajes | Ventanas y chunks normales con `kind:"bot"`; `llm_status=skipped`; **sin packet `#kp`**; gardener y grafo de chats la ignoran (P3-i/j). |
| 6 | Trivial | `kind=chat`, 2 mensajes «ok» / «👍» (< 3 mensajes y < 400 chars) | Ventana + 1 chunk; `llm_status=skipped` (motivo `trivial`); `content` = cabecera + texto (≤1.500); sin packet. Sigue contando en Σ`message_count`. |
| 7 | Voz transcrita tarde | m5 AUDIO con `content=''` dentro de W1; 3 días después se escribe `content` y se inserta `brain_window_dirty` | Antes: m5 no cuenta (regla 4) y no está en W1. Después: m5 entra por su `wa_timestamp`; si no es el primero, mismo `window_id`, hash cambia, reenvío (como caso 2); si queda antes del primero, como caso 3. Línea `HH:MM Nombre: 🎙 texto`. |
| 8 | Mensaje único > 16 k | m1 de 40.000 chars | Una sola ventana (`message_count=1`; nunca dos ventanas con el mismo `first_msg_id`), `truncated_by_size=true`: `window_text` lleva los primeros ≤16.000 chars cortados por párrafo; los **chunks** salen del texto completo, por párrafos, así todo es buscable **[interpretación]** (el contrato no dice si los chunks cubren lo que `window_text` omite). El mensaje siguiente abre ventana nueva. |

## 7. Bots, monitorización y difusión (`chat-kinds.json`)
Formato `{conversation_id: "bot"|"broadcast"}` (regla 6). Criterio de candidato (`scripts/sql/brain-windows-chat-candidates.sql`, solo
lectura): `senders=1` o `top_sender_share ≥ 0,95`, `inbound_share` ≈ 1 (alertas) o ≈ 0 (difusión propia), y los nombres que citó Dani
(Synapse monitor, Alertas Monitoring, Skirmshop ES OP, Pocharlies Operations, Ofertas Chollos).

**Estado: informe de candidatos PENDIENTE.** La consulta a `whatsappmcp` (`kubectl exec` al pod de Postgres) fue denegada a este rol. El
script está listo para quien tenga lectura sobre esa base. `chat-kinds.json` se entrega como `{}` (JSON válido) hasta tener los
`conversation_id` reales; los nombres de Dani no se pueden mapear a id sin esa consulta. El tech-lead confirma la lista antes de P6.

## 8. Calibración pendiente (dry-run del builder, P4)
Histograma de huecos entre mensajes (¿3.600 s parte bien?), distribución de chars por ventana (cuántas tocan 16 k), nº de ventanas
elegibles para LLM (objetivo ~18–20 k) y nº de ventanas `kind != chat`.
