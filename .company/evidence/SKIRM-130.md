# SKIRM-130 — handlebars 4.7.10 (CVE-2026-106445, CVE-2026-106446)

Rama `SKIRM-130-handlebars`, base `origin/deploy/prod` 13698ea. Node v22.23.3, pnpm 11.18.0, trivy 0.70.0 (DB descargada el 2026-10-10).

## Cambio
Override `handlebars: ^4.7.10` en `pnpm-workspace.yaml` (donde están los demás overrides de CVE del repo: INFRA-285, SKIRM-91) y `pnpm-lock.yaml` regenerado con `pnpm install`. `handlebars` es transitiva de `ts-jest` (`^4.7.9`), así que 4.7.10 queda dentro del rango del padre.

## Lock, antes y después
```
antes  (13698ea): handlebars@4.7.9  en packages (l.2347), snapshots (l.6176) y dependencia de ts-jest (l.7723)
después:          handlebars@4.7.10 en las mismas tres líneas, integridad sha512-P5VJMVM7…; ninguna 4.7.9
```
`git diff --stat`: `pnpm-workspace.yaml` +4, `pnpm-lock.yaml` +4/-3 (la línea del override y el renombrado de handlebars; nada más se movió).
Instalado tras `pnpm install`: `node_modules/.pnpm/handlebars@4.7.10`.

## trivy fs (lockfile, incluidas las dependencias de desarrollo)
Comando: `trivy fs --scanners vuln --severity HIGH,CRITICAL --include-dev-deps pnpm-lock.yaml`
```
antes:   Total 3 (HIGH 1, CRITICAL 2): handlebars 4.7.9 CVE-2026-106445 y CVE-2026-106446 (fijadas en 4.7.10); braces 3.0.3 CVE-2026-93687 (sin versión corregida)
después: Total 1 (HIGH 1, CRITICAL 0): braces 3.0.3 CVE-2026-93687, estado `affected`, sin versión corregida
```
Con `--ignore-unfixed` (solo los corregibles): antes 2 (handlebars), después 0.

## Resultados
Desde la raíz del worktree, tras `pnpm install`:
```
pnpm -r build          exit 0 (tsc en mcp-server, shared y conectores)
pnpm -r lint           exit 0 (0 errores, 800 avisos preexistentes en whatsapp-web)
pnpm contract:check    exit 0: Socialmedia contract OK (73 tools)
pnpm -r test           exit 0
  shared                      6 pass /   0 fail
  whatsapp-synapse-bridge    40 pass /   0 fail
  instagram                  53 pass /   0 fail
  telegram                   77 pass /   0 fail
  whatsapp-web              593 pass /   0 fail / 1 skipped (594)
  mcp-server (jest, ts-jest) 697 pass /   0 fail / 8 skipped (705); 57 suites pasan, 1 saltada
```
Sin flakies en esta pasada. `mcp-server` corre con ts-jest sobre handlebars 4.7.10.

## Criterios de aceptación
- C1: handlebars >= 4.7.10 en `pnpm-lock.yaml`: cumplido (ninguna 4.7.9; las tres entradas en 4.7.10).
- C2: `trivy fs` del lockfile sin HIGH/CRITICAL corregibles: cumplido (0 con `--ignore-unfixed`; el único hallazgo es `braces` CVE-2026-93687, que no tiene versión corregida).
