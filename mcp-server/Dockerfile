# INFRA-1500 (INFRA-540 P2) — base comun del dominio fijada por digest: base-node:22
# (docs/images/bases.md de k8s-infra-pocharlies). El host es el registry al que ya
# autentican los workflows de este repo (harbor.lan.e-dani.com); el digest es el
# canonico de bases.md (la misma imagen que harbor.e-dani.com).
FROM harbor.lan.e-dani.com/homelab/base-node:22@sha256:61b7a3ce3746d5f790a3a061eee28d932d778879dee3b367f2519292174f4049

# Debian security updates. The release pipeline refuses any image that still
# carries a fixable HIGH/CRITICAL finding.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# npm only exists here to place pnpm/tsx. It is removed right after: the npm
# bundled with Node ships its own fixable advisories and nothing at runtime
# uses it (services start through node/tsx).
RUN npm install -g pnpm@11.18.0 tsx@4.23.1 \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm
WORKDIR /app

# Install pnpm and tsx globally
# Copy package files
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY patches ./patches
COPY mcp-server/package.json mcp-server/tsconfig.json ./mcp-server/
COPY shared/package.json shared/tsconfig.json ./shared/

# Install dependencies
RUN pnpm install

# Copy source code
COPY mcp-server ./mcp-server
COPY shared ./shared

# Build shared from the packaged sources before starting the server.
WORKDIR /app/shared
RUN pnpm exec tsc --skipLibCheck --noEmit false

# Stay in root app directory
WORKDIR /app

# pnpm only exists here to install and build. It leaves the image here, like npm
# above: the undici bundled inside pnpm ships fixable advisories and nothing at
# runtime calls it (the CMD runs node/tsx directly). /root/.cache/pnpm is its
# metadata cache.
RUN rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx /root/.cache/pnpm

# Expose port
EXPOSE 3000

# Start in dev mode from root (no build required)
# Use sh -c to properly expand the command
# = `pnpm dev` of mcp-server, without pnpm.
CMD ["sh", "-c", "cd mcp-server && exec tsx watch src/main.ts"]
