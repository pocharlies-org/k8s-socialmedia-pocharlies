# SKIRM-103 · pin `whatsapp-connector` (cuenta personal) a v1.3.109

Rol: devops · Fecha: 2026-10-10 · Rama: `SKIRM-103-pin-whatsapp-personal-v1.3.109` · Tronco: `deploy/prod` (3cdf251)

## 1. Digest contra Harbor (PASS)

Comando, desde el x86: `crane digest harbor.e-dani.com/homelab/whatsappmcp-whatsapp-connector:v1.3.109`

```
sha256:0c2d603ad95f050f2cdedec543d5c381f58d797fcb11ec8e17365e4d1f483d23
```

`crane config` de ese digest: `org.opencontainers.image.revision` = `3cdf251d6475284a8281ce9d7de274dff29966a3` (el tronco), linux/amd64.
Run de release: `gh run view 38008072969` → `Release Production`, `success`, `headSha` 3cdf251.

## 2. Render del overlay, tronco contra rama (PASS: una sola línea)

Comando: `kubectl kustomize k8s/overlays/prod` en el tronco y en la rama, y `diff`.

```
1417c1417   (Deployment whatsapp-connector, cuenta personal)
<         image: harbor.e-dani.com/homelab/whatsappmcp-whatsapp-connector:v1.3.103@sha256:0d742e13875e958ce596d3e5e903edb2bb07c0c1bb386fa03b79dc244d5daf71
---
>         image: harbor.e-dani.com/homelab/whatsappmcp-whatsapp-connector:v1.3.109@sha256:0c2d603ad95f050f2cdedec543d5c381f58d797fcb11ec8e17365e4d1f483d23
```

## 3. Diff contra el clúster, solo lectura (PASS)

Comando: `kubectl diff -k k8s/overlays/prod` (nada aplicado). Lo que cambia: la imagen de `whatsapp-connector`
(igual que en el render) y el Job de hook `whatsapp-mcp-migrate` (PreSync de ArgoCD, que se borra al acabar: aparece siempre como alta).
Ningún otro Deployment, Service, ConfigMap ni ExternalSecret cambia. `whatsapp-pairing` (misma imagen, otro pin) no se toca.

## 4. Comprobaciones del repositorio (PASS)

`python3 scripts/render-connectors.py --check` → rc 0 (el generado no cambia: el pin vive en `patch-image.yaml`).

## 5. Criterios

- C15 (parte de esta PR): el pin de `whatsapp-connector` (personal) va en `k8s/overlays/prod/patch-image.yaml`, solo ese Deployment, sin `CONNECTOR_SECRET_STRICT`.
