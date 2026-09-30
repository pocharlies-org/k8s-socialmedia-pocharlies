Rol: developer · Fecha: 2026-10-01 · Sesión: 3a44ef31-094d-4cd0-b324-659ec9d3051a · Estado: LISTO

# INFRA-367 · P1b — entrega (parcial en el criterio 3)

PR: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/149 (rama `INFRA-367-brain-windows-design`, contra `deploy/prod`).
Sin código de runtime: `docs/brain-windows-design.md`, `mcp-server/src/jobs/brain-windows/chat-kinds.json`, `scripts/sql/brain-windows-chat-candidates.sql`.

## Hecho
- Doc de diseño: formato ventana/sub-chunk, `window_id`, cabecera, idempotencia y reapertura, hebbiano (`s+lr(1−s)`, decaimiento 90 d, NPMI), reglas de salto, esquema de extracción LLM, los 8 casos de fixture con resultado esperado.
- 7 fuentes leídas con WebFetch y citadas con URL. Límites declarados: LongMemEval solo el resumen de arXiv; LangChain se cita por el código (la página de docs redirige).
- No modifica el contrato de #147 (se comparó con su `conversation-window-contract.md`). Dos **[interpretación]** para el architect: `truncated_by_size` solo en el troceo de un mensaje (caso 8, no en el corte por tamaño del caso 4) y chunks sobre el texto completo en el caso 8.

## NO hecho (criterio 3, parte de datos)
- El informe de candidatos con recuento por chat **no existe**: `kubectl exec` al pod de Postgres fue denegado por el guard del rol developer; no se buscó otra vía. `chat-kinds.json` es `{}` (JSON válido). Los 5 nombres de Dani quedan sin `conversation_id`.
- Listo para ejecutar por quien tenga lectura: `psql -d whatsappmcp -f scripts/sql/brain-windows-chat-candidates.sql` (lleva `default_transaction_read_only=on`).

## Cómo verificar
`python3 -c "import json;json.load(open('mcp-server/src/jobs/brain-windows/chat-kinds.json'))"` → sin error; leer el doc §1 (fuentes), §6 (8 casos).

## Checklist de 00-spec.md
- [x] El doc cubre los 8 casos de fixture con resultado esperado (§6).
- [x] ≥5 fuentes con URL y una frase de qué se toma (§1: 7).
- [ ] `chat-kinds.json` válido + informe con recuentos: JSON válido `{}`; informe y nombres de Dani PENDIENTES (sin acceso a Postgres).
- [ ] CI verde: pendiente (ESPERA ci). Documentación: es la documentación.
