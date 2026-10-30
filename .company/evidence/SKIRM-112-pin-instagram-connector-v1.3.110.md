# SKIRM-112 pin instagram-connector v1.3.110 (/api/v1 con firma, ventana SC-2092)

Rol: devops · 2026-10-10 · Estado: PASA (verificación previa; PR en borrador, se fusiona solo en la ventana)

## Release
- Run `release.yml` 38021085868 (`image_tag=v1.3.110`, `deploy/prod@8c9ee62`): `success`. Incluye #249.
- Digest: `crane digest harbor.e-dani.com/homelab/whatsappmcp-instagram-connector:v1.3.110` →
  `sha256:58a73ed32419297bfbbfeb7d7c7d90818f489bc5687abcd6af61a97919ad7d49`.
- Rama cortada de `origin/deploy/prod@83a11e5` (conserva #250, #252, #253, #256 y #257).

## Dónde vive el pin
El pin efectivo es el bloque `images:` de `k8s/overlays/prod/kustomization.yaml` (corre después de los parches); el
parche de `instagram-connector` en `patch-image.yaml` lleva el mismo valor y se actualiza con él.

## Render (`kubectl kustomize k8s/overlays/prod`, tronco vs rama) — PASS
Cambia 1 línea `image:` de v1.3.106 → v1.3.110: Deployment `instagram-connector`. Ningún otro workload cambia
(`mcp-server`, `telegram-*` y los conectores de WhatsApp incluidos).

## `kubectl diff -k k8s/overlays/prod` contra el vivo (solo lectura) — PASS
La única línea `image:` de un Deployment que cambia es la de `instagram-connector`. El Job `whatsapp-mcp-migrate`
aparece como alta completa porque es un hook PreSync que se borra al terminar; esta PR no lo toca.

## Sin modo estricto
El overlay no define `CONNECTOR_SECRET_STRICT` (`grep -rn STRICT k8s/` solo da comentarios). Con el valor actual el
conector avisa y acepta; el interruptor estricto es una PR aparte.

## Criterios
- SKIRM-112 C1: el Deployment de Instagram queda pinado a una imagen que contiene la puerta de firma de `/api/v1`
  (#249). La comprobación de qa tras la rotación (C7) no es de esta PR.
