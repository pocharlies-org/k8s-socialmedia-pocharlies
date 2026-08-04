FROM mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07

# The Playwright image already contains the matching Chromium build and all of
# its OS dependencies. Keep browser installation out of both build and startup
# so an external Debian mirror cannot make the worker intermittently unavailable.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# npm only exists here to place pnpm/tsx. It is removed right after: the npm
# bundled with Node ships its own fixable advisories and nothing at runtime
# uses it (services start through pnpm/tsx).
RUN npm install -g pnpm@11.17.0 \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm
WORKDIR /app

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY workers/whatsapp-open-worker/package.json workers/whatsapp-open-worker/tsconfig.json ./workers/whatsapp-open-worker/

RUN pnpm install --filter @mcp-socialmedia/whatsapp-open-worker...

COPY workers/whatsapp-open-worker ./workers/whatsapp-open-worker

WORKDIR /app/workers/whatsapp-open-worker
RUN pnpm build

EXPOSE 3005

CMD ["pnpm", "start"]
