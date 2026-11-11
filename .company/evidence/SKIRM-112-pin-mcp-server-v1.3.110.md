# SKIRM-112 pin mcp-server v1.3.110 (mcp firma /api/v1 de Instagram)

Rol: devops · 2026-10-10 · Estado: PASA (verificación previa al merge)

## Release
- Run `release.yml` 38021085868 (`workflow_dispatch`, `image_tag=v1.3.110`, `deploy/prod@8c9ee62`): `success`.
  Incluye #249 (mcp-server `instagramCall` y job de backfill de Instagram firman `/api/v1`).
- Digest: `crane digest harbor.e-dani.com/homelab/whatsappmcp-mcp-server:v1.3.110` →
  `sha256:bd7ab2f8e1d2c9ebc2cfe5cc4faf734c795e54d09b3bf9ccf91ee24627b2003b`.
- Rama cortada de `origin/deploy/prod@8c9ee62` (conserva los pines #250, #252 y #253).

## Render (`kubectl kustomize k8s/overlays/prod`, tronco vs rama) — PASS
Cambian 7 líneas `image:` de mcp-server v1.3.109 → v1.3.110: Deployment `mcp-server`, `mcp-sse`, `social-api`;
CronJob `brain-windows`, `whatsapp-voice-backfill`, `whatsapp-voice-transcribe`; Job PreSync `whatsapp-mcp-migrate`.
Ningún otro workload cambia (conectores de WhatsApp, Telegram e Instagram, `telegram-sync` incluidos).

## `kubectl diff -k k8s/overlays/prod` contra el vivo (solo lectura) — PASS
Los 7 recursos anteriores y nada más; las únicas líneas `image:` son `whatsappmcp-mcp-server` v1.3.109 → v1.3.110.
El Job `whatsapp-mcp-migrate` es un hook PreSync que se borra al terminar y aparece entero como alta.

## Criterios
- SKIRM-112: los consumidores de `/api/v1` de Instagram que firman (mcp-server y el backfill) quedan pinados a una
  imagen que contiene #249.
