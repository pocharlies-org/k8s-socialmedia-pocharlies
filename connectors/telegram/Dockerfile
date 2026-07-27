FROM harbor.lan.e-dani.com/cache/library/node:22-bookworm-slim

# Debian security updates. The release pipeline refuses any image that still
# carries a fixable HIGH/CRITICAL finding.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# npm only exists here to place pnpm/tsx. It is removed right after: the npm
# bundled with Node ships its own fixable advisories and nothing at runtime
# uses it (services start through pnpm/tsx).
RUN npm install -g pnpm@11.17.0 tsx@4.23.1 \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm
WORKDIR /app

COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml* ./
COPY tsconfig.json ./

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

EXPOSE 3002

CMD ["pnpm", "dev"]
