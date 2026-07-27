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

# Copy package files
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY connectors/tsconfig.json ./connectors/tsconfig.json
COPY connectors/instagram/package.json connectors/instagram/tsconfig.json ./connectors/instagram/
COPY shared/package.json shared/tsconfig.json ./shared/

# Install dependencies
RUN pnpm install

# Copy source code
COPY connectors/instagram ./connectors/instagram
COPY shared ./shared

# Build shared package
WORKDIR /app/shared
RUN pnpm exec tsc --skipLibCheck --noEmit false || true

WORKDIR /app
RUN cd connectors/instagram && pnpm build

EXPOSE 3003

CMD ["sh", "-c", "cd connectors/instagram && pnpm start"]
