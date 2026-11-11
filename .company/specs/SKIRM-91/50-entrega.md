Rol: developer · Fecha: 2026-10-07 · Sesión: 715ef7e4-8c79-4f49-a12d-59a7c4339ea7 · Estado: LISTO

PR: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/219

## Qué se hizo
Bump `sharp` 0.35.4 → 0.35.5 (GHSA-wq5f-xc86-pv6w, librsvg, HIGH) en `connectors/whatsapp-web/package.json`, en el override de `pnpm-workspace.yaml` y en `pnpm-lock.yaml` (regenerado; solo cambian sharp y sus `@img/sharp-*`).

## Cómo verificar
- `grep -c 0.35.4 pnpm-lock.yaml` → 0
- `pnpm install --frozen-lockfile`, `pnpm -r build` exit 0; test whatsapp-web 523 / 522 pass / 0 fail / 1 skipped
- `trivy fs --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed .` → el GHSA desaparece. Queda `@modelcontextprotocol/sdk 1.29.0` CVE-2026-104850 (HIGH, fix 1.31.0), preexistente, fuera de esta PR; puede bloquear la misma puerta.

## Checklist
- [x] sharp ^0.35.5 en package.json y override
- [x] Ninguna sharp@0.35.4 en el lockfile
- [x] Build y tests verdes
- [x] PR contra deploy/prod, sin merge ni deploy

## Reutilizado
- Patrón de INFRA-613 (#217): override en `pnpm-workspace.yaml` + lock regenerado por pnpm. El override `sharp` ya existía; solo se subió.
- Buscado: `grep -n sharp package.json pnpm-workspace.yaml pnpm-lock.yaml connectors/whatsapp-web/package.json`.
- Nuevo: nada de código. Documento a actualizar: ninguno.
