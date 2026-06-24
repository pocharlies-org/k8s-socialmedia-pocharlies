FROM node:20-bookworm AS build

RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml ./
COPY pnpm-lock.yaml* ./
COPY tsconfig.json ./

RUN node -e "require('fs').writeFileSync('package.json', JSON.stringify({ private: true, packageManager: 'pnpm@8.15.0' }))"

COPY shared/package.json ./shared/package.json
COPY connectors/telegram/package.json ./connectors/telegram/package.json

RUN pnpm install --filter @mcp-socialmedia/telegram-connector... --no-frozen-lockfile

COPY shared ./shared
COPY connectors/telegram ./connectors/telegram

RUN pnpm --filter @mcp-socialmedia/shared build
RUN pnpm --filter @mcp-socialmedia/telegram-connector build
RUN pnpm --filter @mcp-socialmedia/telegram-connector deploy --prod /out

FROM node:20-bookworm-slim

WORKDIR /app

COPY --from=build /out ./

EXPOSE 3002

CMD ["node", "dist/main.js"]
