Rol: developer · Fecha: 2026-10-10 · Sesión: 715ef7e4-8c79-4f49-a12d-59a7c4339ea7 · Estado: LISTO

PR: contra `deploy/prod`, rama `SKIRM-130-handlebars` (título `SKIRM-130 fix(deps): handlebars 4.7.10 …`)

## Qué se hizo
Override de pnpm `handlebars: ^4.7.10` en `pnpm-workspace.yaml` y `pnpm-lock.yaml` regenerado: handlebars pasa de 4.7.9 a 4.7.10 (CVE-2026-106445 y CVE-2026-106446, CRITICAL). Es transitiva de `ts-jest` (dependencia de desarrollo). No se toca el Dockerfile: el override sirve igual si la dependencia llega a la imagen.

## Cómo verificar
- `grep -n handlebars pnpm-lock.yaml` → solo 4.7.10.
- `trivy fs --scanners vuln --severity HIGH,CRITICAL --include-dev-deps --ignore-unfixed pnpm-lock.yaml` → 0. Sin `--ignore-unfixed` queda `braces` 3.0.3 CVE-2026-93687 (HIGH, sin versión corregida).
- Build, lint, `contract:check` y `pnpm -r test` en verde: `.company/evidence/SKIRM-130.md`.

## Checklist
- [x] handlebars >= 4.7.10 en pnpm-lock.yaml
- [x] trivy fs del lockfile sin HIGH/CRITICAL corregibles
- [ ] La release siguiente (v1.3.109) pasa la puerta y la PR de pin de mcp-server (SKIRM-106) puede abrirse (se comprueba tras el merge, al lanzar la release)

## Reutilizado
- Patrón de INFRA-285 (#122) y SKIRM-91 (#219): override en `pnpm-workspace.yaml` + lock regenerado por pnpm; mismo estilo de comentario con el CVE y cuándo retirarlo.
- Buscado: `rg -n "handlebars" pnpm-lock.yaml package.json pnpm-workspace.yaml`, `git log --grep=SKIRM-91 --grep=INFRA-285`.
- Nuevo: solo la entrada del override (4 líneas con su comentario). Sin código. Documento a actualizar: ninguno.
