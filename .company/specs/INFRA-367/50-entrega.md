Rol: developer · Fecha: 2026-10-01 · Sesión: 3a44ef31-094d-4cd0-b324-659ec9d3051a · Estado: LISTO

# INFRA-367 · P1b — entrega (3.ª: decisión del tech-lead aplicada)

PR: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/149 (rama `INFRA-367-brain-windows-design`, contra `deploy/prod`).
Ficheros: `docs/brain-windows-design.md`, `mcp-server/src/jobs/brain-windows/chat-kinds.json`, `scripts/sql/brain-windows-chat-candidates.sql`.

## Hecho
- Doc de diseño: formato ventana/sub-chunk, `window_id`, idempotencia y reapertura, hebbiano/NPMI, reglas de salto, esquema LLM, 8 casos de fixture, 7 fuentes con URL. No contradice el contrato de #147. Dos **[interpretación]** para el architect (revisa en #149).
- **§7.1 informe de candidatos** con recuento por chat, a partir de `nota-sre-chat-candidates.md` (sre, consulta de solo lectura: 60 + 8 filas).
- `chat-kinds.json` (JSON válido, 13 entradas): 8 `bot` (Synapse monitor ×2, Alertas Monitoring Skirmshop, github pocharlies-org, Skirmshop ES OP ×2, Pocharlies Operations ×2) y 5 `broadcast` (Ofertas Chollos, Anonymous Catalonia, Airsoft4Tiesos, Airsoft Ibérico, COPA NACIONAL). 144.851 de 787.940 mensajes (≈18,4 %).
- Decisión cerrada del tech-lead en §7.2: Hogar, Openclaw, Hermes Pocharlies, DGX Studio, Skirmshop Spain Hermes y Daniel & Leila IA se quedan `chat` (conversación humana con sustancia).
- Límites: 2 canales (Airsoft4Tiesos, Airsoft Ibérico) marcados `broadcast` por estructura (1 remitente, 100 % entrante, id `-100…`), no por tipo confirmado; el `type` de `conversations` no es fiable.

## Cómo verificar
`python3 -c "import json;print(len(json.load(open('mcp-server/src/jobs/brain-windows/chat-kinds.json'))))"` → 13. Doc §7.1.

## Checklist de 00-spec.md
- [x] El doc cubre los 8 casos de fixture con resultado esperado (§6).
- [x] ≥5 fuentes con URL y una frase de qué se toma (§1: 7).
- [x] `chat-kinds.json` válido + informe con recuento por chat; los 5 nombres de Dani aparecen (§7.1, bots o dudosos).
- [ ] CI verde: pendiente (ESPERA ci). Documentación: es la documentación.
