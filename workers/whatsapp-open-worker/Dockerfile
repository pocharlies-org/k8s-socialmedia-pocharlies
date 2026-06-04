FROM node:20-bookworm

WORKDIR /app

RUN npm install -g pnpm@8.15.0 tsx@4.7.0

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY workers/whatsapp-open-worker/package.json workers/whatsapp-open-worker/tsconfig.json ./workers/whatsapp-open-worker/

RUN pnpm install --filter @mcp-socialmedia/whatsapp-open-worker...

COPY workers/whatsapp-open-worker ./workers/whatsapp-open-worker

WORKDIR /app/workers/whatsapp-open-worker
RUN pnpm build

EXPOSE 3005

CMD ["sh", "-c", "pnpm exec playwright install --with-deps chromium && pnpm start"]
