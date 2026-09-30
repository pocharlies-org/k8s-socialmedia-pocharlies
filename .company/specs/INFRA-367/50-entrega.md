Rol: developer · Fecha: 2026-10-01 · Sesión: 3a44ef31-094d-4cd0-b324-659ec9d3051a · Estado: LISTO

# INFRA-367 · P1b — entrega (5.ª: ronda 2, caso 8)

PR: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/149 (rama `INFRA-367-brain-windows-design`, contra `deploy/prod`).
Ficheros: `docs/brain-windows-design.md`, `mcp-server/src/jobs/brain-windows/chat-kinds.json`, `scripts/sql/brain-windows-chat-candidates.sql`.

## Hecho
- Doc de diseño: formato ventana/sub-chunk, `window_id`, idempotencia y reapertura, hebbiano/NPMI, reglas de salto, esquema LLM, 8 casos de fixture, 7 fuentes con URL. No contradice el contrato de #147. Rework 1: aplicados los 2 hallazgos del architect (marca de respuesta al final; enum de entidades en minúsculas) y fijadas sus 2 interpretaciones como regla (sin marcas). Ronda 2: el architect revocó «chunks sobre el texto completo»; el doc ya dice (§2 y caso 8) que los chunks cubren solo `window_text`, el exceso del mensaje >16 k no se indexa en v1, `message_count=1`, `msg_id_first = msg_id_last`, `chunk_count` real, una petición, `window_hash` sobre el mensaje completo. Revisado el doc entero: ninguna frase dice lo contrario. Nota del architect (id 14211): PASA sobre head c773ee3.
- **§7.1 informe de candidatos** con recuento por chat, a partir de `nota-sre-chat-candidates.md` (sre, consulta de solo lectura: 60 + 8 filas).
- `chat-kinds.json` (JSON válido, 13 entradas): 8 `bot` (Synapse monitor ×2, Alertas Monitoring Skirmshop, github pocharlies-org, Skirmshop ES OP ×2, Pocharlies Operations ×2) y 5 `broadcast` (Ofertas Chollos, Anonymous Catalonia, Airsoft4Tiesos, Airsoft Ibérico, COPA NACIONAL). 144.851 de 787.940 mensajes (≈18,4 %).
- Decisión cerrada del tech-lead en §7.2: Hogar, Openclaw, Hermes Pocharlies, DGX Studio, Skirmshop Spain Hermes y Daniel & Leila IA se quedan `chat` (conversación humana con sustancia).
- Revisión del doc entero contra §C y `chat-kinds.json`: §7.2 punto 1 corregido (8 bot + 5 broadcast), ejemplo del caso 4 con prefijo de línea, `invalid_json` como motivo del builder (no del modelo), señales de §7 vs decisión expresa; tabla §7.1 = JSON (comprobado por script, 13 ids).
- Límites: 2 canales (Airsoft4Tiesos, Airsoft Ibérico) marcados `broadcast` por estructura (1 remitente, 100 % entrante, id `-100…`), no por tipo confirmado; el `type` de `conversations` no es fiable.

## Cómo verificar
`python3 -c "import json;print(len(json.load(open('mcp-server/src/jobs/brain-windows/chat-kinds.json'))))"` → 13. Doc §7.1.

## Checklist de 00-spec.md
- [x] El doc cubre los 8 casos de fixture con resultado esperado (§6).
- [x] ≥5 fuentes con URL y una frase de qué se toma (§1: 7).
- [x] `chat-kinds.json` válido + informe con recuento por chat; los 5 nombres de Dani aparecen (§7.1, bots o dudosos).
- [ ] CI verde: pendiente (ESPERA ci). Documentación: es la documentación.
