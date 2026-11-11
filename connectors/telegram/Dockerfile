FROM node:22-bookworm-slim

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

COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml* ./
COPY tsconfig.json ./
COPY patches ./patches

COPY shared ./shared
COPY connectors/telegram ./connectors/telegram

# --no-optional used to be here to dodge native build issues. It must not come
# back: esbuild ships its platform binary as an OPTIONAL dependency, so skipping
# optionals leaves tsx without a backend and `pnpm dev` dies at boot. Which build
# scripts may run is now declared explicitly in pnpm-workspace.yaml (allowBuilds).
RUN pnpm install --frozen-lockfile

WORKDIR /app/shared
RUN pnpm build || true

WORKDIR /app/connectors/telegram

# pnpm only exists here to install and build. It leaves the image here, like npm
# above: the undici bundled inside pnpm ships fixable advisories and nothing at
# runtime calls it (the CMD runs node/tsx directly). /root/.cache/pnpm is its
# metadata cache.
RUN rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx /root/.cache/pnpm

EXPOSE 3002

# = `pnpm dev` of connectors/telegram, without pnpm.
CMD ["tsx", "watch", "src/main.ts"]
