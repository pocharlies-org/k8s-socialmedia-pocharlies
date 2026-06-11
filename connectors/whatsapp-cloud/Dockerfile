FROM node:20-bookworm

WORKDIR /app

RUN npm install -g pnpm@8.15.0

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY connectors/tsconfig.json ./connectors/tsconfig.json
COPY connectors/whatsapp-cloud/package.json connectors/whatsapp-cloud/tsconfig.json ./connectors/whatsapp-cloud/
COPY shared/package.json shared/tsconfig.json ./shared/

RUN pnpm install

COPY connectors/whatsapp-cloud ./connectors/whatsapp-cloud
COPY shared ./shared

WORKDIR /app/shared
RUN pnpm build

WORKDIR /app/connectors/whatsapp-cloud
RUN pnpm build

EXPOSE 3004

CMD ["node", "dist/main.js"]
