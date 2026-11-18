# SKIRM-111 pin telegram-sync v1.3.110 (firma /api/public/send)

Rol: devops · 2026-10-10 · Estado: PASA (verificación previa al merge)

## Release
- Run `release.yml` 38021085868 (`workflow_dispatch`, `image_tag=v1.3.110`, `deploy/prod@8c9ee62`): `success`.
  Incluye #251 (`telegram-sync` firma la lectura y `POST /api/public/send`).
- Digest: `crane digest harbor.e-dani.com/homelab/whatsappmcp-telegram-sync:v1.3.110` →
  `sha256:d8f1e7bb12d930e6447d2270cf714275fa350e9899f1594c47f8c45c2a642b1e`.
- Rama cortada de `origin/deploy/prod@8c9ee62` (conserva los pines #250, #252 y #253).

## Render (`kubectl kustomize k8s/overlays/prod`, tronco vs rama) — PASS
Cambian 2 líneas `image:` de telegram-sync v1.3.105 → v1.3.110: Deployment `telegram-sync` y
`telegram-sync-professional` (mismo nombre de imagen). Ningún otro workload cambia (conectores de Telegram,
Instagram y WhatsApp, `mcp-server` incluidos).

## `kubectl diff -k k8s/overlays/prod` contra el vivo (solo lectura) — PASS
Las únicas líneas `image:` que cambian son las dos de `telegram-sync`. El Job `whatsapp-mcp-migrate` aparece como alta
completa porque es un hook PreSync que se borra al terminar; esta PR no lo toca (sigue en mcp-server v1.3.109).

## Criterios
- SKIRM-111 C2: `telegram-sync` y `telegram-sync-professional` quedan pinados a una imagen que contiene la firma (#251).
