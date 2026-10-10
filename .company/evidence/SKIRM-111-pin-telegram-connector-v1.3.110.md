# SKIRM-111 pin telegram-connector v1.3.110 (/api/public con firma, ventana SC-2092)

Rol: devops · 2026-10-10 · Estado: PASA (verificación previa; PR en borrador, se fusiona solo en la ventana)

## Release
- Run `release.yml` 38021085868 (`image_tag=v1.3.110`, `deploy/prod@8c9ee62`): `success`. Incluye #251.
- Digest: `crane digest harbor.e-dani.com/homelab/whatsappmcp-telegram-connector:v1.3.110` →
  `sha256:dfadd7054ff6a9925be03b41af37b663f1262a39343a8cb0b59242ef1d130f93`.
- Rama cortada de `origin/deploy/prod@83a11e5` (conserva #250, #252, #253, #256 y #257).

## Dónde vive el pin
`telegram-connector` y `telegram-connector-professional` se pinan en `k8s/overlays/prod/patch-image.yaml` (el bloque
`images:` de `kustomization.yaml` ya no lleva ese nombre). `telegram-pairing` está en el mismo fichero, en v1.3.57,
y no se toca.

## Render (`kubectl kustomize k8s/overlays/prod`, tronco vs rama) — PASS
Cambian 2 líneas `image:` de v1.3.105 → v1.3.110: Deployment `telegram-connector` y `telegram-connector-professional`.
`telegram-pairing` sigue en `whatsappmcp-telegram-connector:v1.3.57@sha256:8594502b…`. Ningún otro workload cambia.

## `kubectl diff -k k8s/overlays/prod` contra el vivo (solo lectura) — PASS
Las únicas líneas `image:` de los Deployments que cambian son esas dos. El Job `whatsapp-mcp-migrate` aparece como alta
completa porque es un hook PreSync que se borra al terminar; esta PR no lo toca.

## Sin modo estricto
El overlay no define `CONNECTOR_SECRET_STRICT` en ningún sitio (`grep -rn STRICT k8s/` solo da comentarios). Con el
valor actual el conector avisa y acepta; el interruptor estricto es una PR aparte.

## Criterios
- SKIRM-111 C1: los Deployments de Telegram quedan pinados a una imagen que contiene la puerta de firma de
  `/api/public/*` (#251). La comprobación de qa tras la rotación (C6) no es de esta PR.
