# INFRA-745 — imagen del bot diario de verificacion facial del grupo Sauvage.
# Base exacta de connectors/telegram/Dockerfile (veredicto del architect: no
# existe ninguna imagen de la compania que traiga node + opencode). Trae
# opencode-ai fijado a la version del digest en produccion (1.18.30): el job
# del CronJob lanza `opencode run` headless contra LiteLLM y los scripts
# versionados del paquete.
FROM node:22-bookworm-slim

# Debian security updates. The release pipeline refuses any image that still
# carries a fixable HIGH/CRITICAL finding.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# npm only exists here to place pnpm/tsx/opencode. It is removed right after:
# the npm bundled with Node ships its own fixable advisories and nothing at
# runtime uses it (opencode's binary bundles the provider SDK — measured with
# opencode-ai 1.18.30, no npm at run time).
RUN npm install -g pnpm@11.18.0 tsx@4.23.1 opencode-ai@1.18.30 \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm

WORKDIR /app

COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml* ./
COPY tsconfig.json ./
COPY patches ./patches

COPY shared ./shared
COPY sauvage-verificacion ./sauvage-verificacion

RUN pnpm install --frozen-lockfile

WORKDIR /app/shared
RUN pnpm build || true

WORKDIR /app/sauvage-verificacion

# pnpm only exists here to install. It leaves the image here, like npm above.
RUN rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx /root/.cache/pnpm

# El CronJob fija su propio command (opencode run); esto es el fallback.
CMD ["node", "--import", "tsx", "src/main-pasada.ts"]
