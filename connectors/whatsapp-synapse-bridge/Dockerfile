FROM node:20-bookworm

WORKDIR /app

RUN npm install -g pnpm@8.15.0

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
