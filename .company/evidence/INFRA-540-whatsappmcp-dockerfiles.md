# Evidencia INFRA-1500 — Dockerfiles whatsappmcp sobre base común por digest + guard

Rama: `INFRA-540-whatsappmcp-dockerfiles` (base `origin/deploy/prod`).
Dónde: worktree local del clone `k8s-socialmedia-pocharlies`; greps y hadolint (v2.15.1,
el mismo digest que fija el reusable) ejecutados aquí; `docker` no existe en este host
(se comprueba con `command -v docker` → ausente), la verificación de build la hace el
job `standard` de `ci.yml` (`run_docker_build`, PR interna → arc-k8s con login a
`harbor.lan.e-dani.com`, que es el host de las bases).

## Test que debía fallar primero — `grep -n '^FROM'` sin `@sha256:`

ANTES (12 líneas FROM en los 11 Dockerfiles, 0 con digest — `git show origin/deploy/prod:<f>`):

```text
apps/whatsapp/Dockerfile:1:FROM node:22-alpine AS build
apps/whatsapp/Dockerfile:9:FROM node:22-alpine
connectors/correo-bridge/Dockerfile:1:FROM harbor.lan.e-dani.com/cache/library/node:22-bookworm-slim
connectors/instagram/Dockerfile:1:FROM node:22-bookworm-slim
connectors/telegram/Dockerfile:1:FROM node:22-bookworm-slim
connectors/telegram-sync/Dockerfile:1:FROM python:3.12-slim
connectors/whatsapp-cloud/Dockerfile:1:FROM harbor.lan.e-dani.com/cache/library/node:22-bookworm-slim
connectors/whatsapp-synapse-bridge/Dockerfile:1:FROM harbor.lan.e-dani.com/cache/library/node:22-bookworm-slim
connectors/whatsapp-web/Dockerfile:1:FROM node:22-bookworm-slim
mcp-server/Dockerfile:1:FROM node:22-bookworm-slim
sauvage-verificacion/Dockerfile:7:FROM node:22-bookworm-slim
workers/whatsapp-open-worker/Dockerfile:1:FROM harbor.lan.e-dani.com/cache/library/node:22-bookworm-slim
```

DESPUÉS (16 FROM en 11 Dockerfiles — 4 multi-stage ×2 —, todos con `@sha256:`):

```text
apps/whatsapp/Dockerfile:6:FROM node:22-alpine@sha256:1314fb30… AS build
apps/whatsapp/Dockerfile:14:FROM node:22-alpine@sha256:1314fb30…
connectors/correo-bridge/Dockerfile:5:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce… AS build
connectors/correo-bridge/Dockerfile:41:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce… AS runtime
connectors/instagram/Dockerfile:5:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce… AS build
connectors/instagram/Dockerfile:43:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce… AS runtime
connectors/telegram-sync/Dockerfile:5:FROM harbor.lan.e-dani.com/homelab/base-python-slim-uv:3.12@sha256:e2b290bd…
connectors/telegram/Dockerfile:5:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce…
connectors/whatsapp-cloud/Dockerfile:5:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce… AS build
connectors/whatsapp-cloud/Dockerfile:41:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce… AS runtime
connectors/whatsapp-synapse-bridge/Dockerfile:5:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce… AS build
connectors/whatsapp-synapse-bridge/Dockerfile:41:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce… AS runtime
connectors/whatsapp-web/Dockerfile:5:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce…
mcp-server/Dockerfile:5:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce…
sauvage-verificacion/Dockerfile:11:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce…
workers/whatsapp-open-worker/Dockerfile:5:FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce…
```

(Digests abreviados; completos en los ficheros. Los 9 node:22-bookworm-slim — las dos
grafías, `cache/library/*` y Docker Hub, incluido `sauvage-verificacion` que el spec no
nombraba — sobre la misma base-node; `telegram-sync` sobre base-python-slim-uv.)

Comando y resultado: `grep -rn '^FROM' --include=Dockerfile . | grep -vc '@sha256:'` →
`0` (antes: 12). PASS.

## Test 2 — guard conectado

`grep -rEl 'image-guard|hadolint' .github/workflows/` → antes: vacío (falla);
después: `.github/workflows/release.yml`. PASS.

## hadolint (v2.15.1)

Bucle sobre los 11 Dockerfiles (`hadolint <f>`; umbral por defecto = fallo con warnings):
los 11 con exit 0. PASS. Dos warnings preexistentes (DL3008 xauth en
`workers/whatsapp-open-worker`, DL3018 ffmpeg en `apps/whatsapp`) quedan silenciados con
`# hadolint ignore=` y su motivo al lado: fijar versión de paquete rompe el build cuando
el repo del SO la actualiza, y el `apt-get upgrade`/repo flotante es deliberado (hallazgos
de seguridad); la reproducibilidad la da el digest de la base.

## Otros checks locales

- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"` → ok.
- `python3 scripts/render-connectors.py --check` → exit 0 (job `connectors-generated` de ci.yml).
- `git diff --stat origin/deploy/prod` → 12 ficheros: los 11 Dockerfiles + `release.yml`.
- `company-duplicados`: no reporta clones en los Dockerfiles (jscpd no escanea ese formato);
  los 71 "nuevos" que lista son TS ya existentes en el tronco (el detector local compara
  contra la rama por defecto del remoto, no contra `deploy/prod`); el reusable de CI compara
  contra la base del PR y este diff no añade TS.

## docker build

No ejecutado aquí (sin demonio docker en este host — medido). Lo cubre el job `standard`
de `ci.yml` (`run_docker_build` en PR interna: construye telegram-connector,
telegram-sync, instagram, whatsapp-web, whatsapp-cloud, open-worker, mcp-server,
whatsapp-app, sauvage-verificacion con login a `harbor.lan.e-dani.com`), y P3 construye y
mide las 11 en el release.

## Criterios

- C1 (Dockerfile saneado): PASS — multi-stage en los 4 conectores con CMD compilada
  (correo-bridge, whatsapp-cloud, whatsapp-synapse-bridge, instagram: etapa runtime =
  node + deps de producción + dist, sin pnpm/tsx/devDeps/fuente); deps antes que código en
  todos (manifiestos → install → código, ya era el patrón y se mantiene); sin caché
  npm/pnpm/pip en la capa final (limpiezas existentes + capas de build fuera de la final).
  Los 5 que ejecutan tsx/playwright en runtime (telegram, whatsapp-web, mcp-server,
  sauvage-verificacion, whatsapp-open-worker) siguen de una etapa: multi-stage no aplica
  sin cambiar el comportamiento de la CMD (corren en modo dev/watch con tsx).
- C3 (base común por digest): PASS — 9 node sobre `base-node:22@sha256:61b7a3ce…`,
  telegram-sync sobre `base-python-slim-uv:3.12@sha256:e2b290bd…` (digests canónicos de
  `k8s-infra@main:docs/images/bases.md`, verificados con `crane digest` en el host LAN);
  apps/whatsapp se queda en alpine (536 no la declara pila común con 3+ consumidoras
  propias) pero fijado por digest.
- C5 (guard conectado): PASS — job `image-guard` en `release.yml`: matriz de las 11
  imágenes con etiquetas `IMAGE:`/`DOCKERFILE:`, reusable fijado por SHA
  (`reusable-image-guard.yml@ab1afdcb…`), secretos `HARBOR_USER`/`HARBOR_PASSWORD`,
  `baseline:` URL cruda a `k8s-infra@main:docs/images/sizes-baseline.json` (accesible
  anónima: HTTP 200 medido con curl), `modo: bloquear`.
