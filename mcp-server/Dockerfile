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

# Install pnpm and tsx globally
# Copy package files
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY mcp-server/package.json mcp-server/tsconfig.json ./mcp-server/
COPY shared/package.json shared/tsconfig.json ./shared/

# Install dependencies
RUN pnpm install

# Copy source code
COPY mcp-server ./mcp-server
COPY shared ./shared

# Build shared package (ignore errors for development)
WORKDIR /app/shared
RUN pnpm exec tsc --skipLibCheck --noEmit false || true

# Stay in root app directory
WORKDIR /app

# Expose port
EXPOSE 3000

# Start in dev mode from root (no build required)
# Use sh -c to properly expand the command
CMD ["sh", "-c", "cd mcp-server && pnpm dev"]
