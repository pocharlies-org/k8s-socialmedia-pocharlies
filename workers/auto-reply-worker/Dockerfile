FROM node:20-bookworm-slim AS builder

WORKDIR /worker

COPY workers/auto-reply-worker/package.json ./
RUN npm install

COPY workers/auto-reply-worker/tsconfig.json ./
COPY workers/auto-reply-worker/index.ts ./
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim

WORKDIR /worker

COPY --from=builder /worker/dist ./dist
COPY --from=builder /worker/node_modules ./node_modules
COPY --from=builder /worker/package.json ./

ENV NODE_ENV=production
ENV CONFIG_PATH=/worker/config.json

CMD ["node", "/worker/dist/index.js"]
