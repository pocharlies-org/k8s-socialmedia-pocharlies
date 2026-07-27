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

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY connectors/tsconfig.json ./connectors/tsconfig.json
COPY connectors/whatsapp-synapse-bridge/package.json connectors/whatsapp-synapse-bridge/tsconfig.json ./connectors/whatsapp-synapse-bridge/
COPY shared/package.json shared/tsconfig.json ./shared/

RUN pnpm install

COPY connectors/whatsapp-synapse-bridge ./connectors/whatsapp-synapse-bridge
COPY shared ./shared

WORKDIR /app/shared
RUN pnpm build

WORKDIR /app/connectors/whatsapp-synapse-bridge
RUN pnpm build

EXPOSE 3006

CMD ["node", "dist/main.js"]
