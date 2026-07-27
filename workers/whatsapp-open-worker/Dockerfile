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

RUN apt-get update \
  && apt-get install -y --no-install-recommends xauth \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY workers/whatsapp-open-worker/package.json workers/whatsapp-open-worker/tsconfig.json ./workers/whatsapp-open-worker/

RUN pnpm install --filter @mcp-socialmedia/whatsapp-open-worker...

COPY workers/whatsapp-open-worker ./workers/whatsapp-open-worker

WORKDIR /app/workers/whatsapp-open-worker
RUN pnpm build

EXPOSE 3005

CMD ["sh", "-c", "pnpm exec playwright install --with-deps chromium && xvfb-run -a --server-args='-screen 0 1365x900x24' pnpm start"]
