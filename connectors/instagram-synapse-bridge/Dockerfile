FROM harbor.lan.e-dani.com/cache/library/node:22-bookworm-slim

RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@11.17.0 \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm

WORKDIR /app

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY connectors/tsconfig.json ./connectors/tsconfig.json
COPY connectors/instagram-synapse-bridge/package.json connectors/instagram-synapse-bridge/tsconfig.json ./connectors/instagram-synapse-bridge/

RUN pnpm install --frozen-lockfile

COPY connectors/instagram-synapse-bridge ./connectors/instagram-synapse-bridge

WORKDIR /app/connectors/instagram-synapse-bridge
RUN pnpm build

EXPOSE 3007

CMD ["node", "dist/main.js"]
