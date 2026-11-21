# INFRA-1500 (INFRA-540 P2) — base común del dominio fijada por digest:
# base-node:22 (docs/images/bases.md de k8s-infra-pocharlies). El host es el
# registry al que ya autentican los workflows de este repo (harbor.lan.e-dani.com);
# el digest es el canónico de bases.md (la misma imagen que harbor.e-dani.com).
FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce3746d5f790a3a061eee28d932d778879dee3b367f2519292174f4049 AS build

# Debian security updates. The release pipeline refuses any image that still
# carries a fixable HIGH/CRITICAL finding.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# npm only exists here to place pnpm/tsx. It is removed right after: the npm
# bundled with Node ships its own fixable advisories and nothing at runtime
# uses it (services start through node/tsx).
RUN npm install -g pnpm@11.18.0 tsx@4.23.1 \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm
WORKDIR /app

# Copy package files (dependencias antes que código)
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY patches ./patches
COPY connectors/tsconfig.json ./connectors/tsconfig.json
COPY connectors/instagram/package.json connectors/instagram/tsconfig.json ./connectors/instagram/
COPY shared/package.json shared/tsconfig.json ./shared/

# Install dependencies
RUN pnpm install

# Copy source code
COPY connectors/instagram ./connectors/instagram
COPY shared ./shared

# Build shared package
WORKDIR /app/shared
RUN pnpm exec tsc --skipLibCheck --noEmit false

WORKDIR /app/connectors/instagram
RUN pnpm build

# Etapa final: node + dependencias de producción + artefacto compilado. Sin
# pnpm, sin tsx, sin devDependencies, sin código fuente (todo eso se queda en
# la etapa de build).
FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce3746d5f790a3a061eee28d932d778879dee3b367f2519292174f4049 AS runtime

RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# pnpm solo existe para instalar las dependencias de producción; sale de la
# imagen al terminar, como npm justo arriba.
RUN npm install -g pnpm@11.18.0 \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm
WORKDIR /app

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY patches ./patches
COPY connectors/tsconfig.json ./connectors/tsconfig.json
COPY connectors/instagram/package.json connectors/instagram/tsconfig.json ./connectors/instagram/
COPY shared/package.json shared/tsconfig.json ./shared/

RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/connectors/instagram/dist ./connectors/instagram/dist

RUN rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx /root/.cache/pnpm

EXPOSE 3003

# = `pnpm start` of connectors/instagram, without pnpm.
CMD ["sh", "-c", "cd connectors/instagram && exec node dist/main.js"]
