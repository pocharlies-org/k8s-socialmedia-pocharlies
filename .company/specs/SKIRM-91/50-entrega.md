Rol: developer · Fecha: 2026-10-07 · Sesión: f6883094-407b-472e-87c1-40c26e8d9c97 · Estado: LISTO

PR: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/219

## Qué se hizo
Dos bumps mínimos para desbloquear la puerta de Trivy de la release:
- `sharp` 0.35.4 → 0.35.5 (GHSA-wq5f-xc86-pv6w): `connectors/whatsapp-web/package.json`, override de `pnpm-workspace.yaml`, lock (solo sharp y `@img/sharp-*`).
- `@modelcontextprotocol/sdk` 1.29.0 → 1.31.0 (CVE-2026-104850): `mcp-server/package.json` (`^1.31.0`), lock con solo la entrada del sdk (specifier, versión y resoluciones). Rango `^1.31.0`, lock resuelto a 1.31.0 a propósito: 1.32.1 arrastraba 12 transitivas (seguimiento aparte, ver nota del architect).

Changelog sdk 1.30.0/1.30.1/1.31.0 revisado: cambios internos del transporte HTTP y de auth de cliente OAuth; mcp-server solo importa `server/index|sse|stdio|streamableHttp` y `types`, sin auth de cliente. Sin impacto de API.

## Cómo verificar
- `grep -c "0.35.4\|sdk@1.29.0" pnpm-lock.yaml` → 0
- `pnpm install --frozen-lockfile`, `pnpm -r build`, `tsc --noEmit` (mcp-server): exit 0; `pnpm -r lint`: 0 errores
- mcp-server 634 pass / 8 skipped / 0 fail; whatsapp-web 522 pass / 0 fail / 1 skipped; instagram 41/41; telegram 66/66; bridge 40/40. (Con `pnpm -r test` en paralelo fallaron 2 tests de whatsapp-web sensibles al tiempo; aislado, 0 fail; no usa el sdk.)
- `pnpm contract:check` OK (73 tools, sha256 sin cambio); `scripts/render-connectors.py --check` exit 0
- `trivy fs --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed .` → 0 vulnerabilidades

## Checklist
- [x] sharp ^0.35.5 (package.json y override), sin sharp@0.35.4 en el lock
- [x] @modelcontextprotocol/sdk ^1.31.0, lock mínimo
- [x] Build, tsc, lint, suites, contract:check y render --check verdes
- [x] Trivy sin fixables HIGH/CRITICAL
- [x] PR #219 contra deploy/prod; fusionada squash como f9d181f (deploy: decisión del operador, fuera de este encargo)

## Reutilizado
- Patrón de INFRA-613 (#217). El override `sharp` ya existía; solo se subió. El sdk se sube en el `package.json` donde se declara, sin override nuevo.
- Buscado: `grep -rn "modelcontextprotocol/sdk" --include=package.json`, `grep -rhoE "@modelcontextprotocol/sdk/..." mcp-server/src`, y uso de providers OAuth del sdk (ninguno).
- Nuevo: nada de código. Documento a actualizar: ninguno.
