# SKIRM-106 pin mcp-server v1.3.109 (migración 021)

Rol: devops · 2026-10-10 · Estado: PASA (verificación previa al merge)

## Release
- Run `release.yml` 38008072969 (`workflow_dispatch`, `image_tag=v1.3.109`, `deploy/prod@3cdf251`): `success`
  (contract, build/publish con puerta Trivy, manifests). v1.3.108 (run 38004230340) quemado por la puerta Trivy
  (handlebars 4.7.9); lo arregla SKIRM-130 (#248), incluido en `3cdf251`.
- Digest: `crane digest harbor.e-dani.com/homelab/whatsappmcp-mcp-server:v1.3.109` →
  `sha256:f2ef9945b78397ff1fadf43fc7bcdf2dbf7d6caab079e59a98b8e69b7e9c8980`.
- La imagen por digest contiene la migración y el handlebars corregido:

```
$ crane export harbor.e-dani.com/homelab/whatsappmcp-mcp-server@sha256:f2ef… - | tar -t | grep -E 'migrations/021_|handlebars/package.json'
app/mcp-server/src/infrastructure/database/migrations/021_whatsapp_novedades_channels.sql
app/node_modules/.pnpm/handlebars@4.7.10/node_modules/handlebars/package.json
```

## Render (`kubectl kustomize k8s/overlays/prod`, antes y después del cambio) — PASS
Solo cambia la línea `image:` de mcp-server v1.3.107 → v1.3.109 (7 líneas, 7 workloads):
Deployment `mcp-server`, `mcp-sse`, `social-api`; CronJob `brain-windows`, `whatsapp-voice-backfill`,
`whatsapp-voice-transcribe`; Job PreSync `whatsapp-mcp-migrate`. Los Deployments de los conectores de WhatsApp,
Telegram e Instagram no cambian.

## `kubectl diff -k k8s/overlays/prod` contra el vivo (solo lectura) — PASS
Las únicas líneas `image:` que cambian son las de `whatsappmcp-mcp-server` (v1.3.107 → v1.3.109) en los
Deployments y CronJobs anteriores; el Job `whatsapp-mcp-migrate` es un hook PreSync que se borra al terminar y
aparece entero como alta. El resto del diff es ruido del servidor (`generation`, `controller-uid`).

## Criterios
- C3: el overlay prod fija `mcp-server` a una imagen que contiene la migración 021 (comprobado arriba).
