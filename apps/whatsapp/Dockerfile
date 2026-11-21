# INFRA-1500 (INFRA-540 P2) — se queda en alpine: el inventario de INFRA-536
# (docs/images/inventario.json de k8s-infra) no llega a 3 consumidoras propias
# de la pila alpine, así que no hay base común alpine que adoptar (bases.md fija
# solo base-node:22 glibc y base-python-slim-uv:3.12). Ya era multi-stage de 2
# etapas; el FROM queda fijado por digest como el resto de bases del dominio.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY assistant ./assistant
COPY vite.config.mjs ./
RUN npm run build

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
ENV NODE_ENV=production TZ=Europe/Madrid
WORKDIR /app
# El digest de la base (arriba) fija el snapshot de Alpine; fijar la versión de
# ffmpeg rompería el build cuando el repo de Alpine la actualice.
# hadolint ignore=DL3018
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json ./
# La app en runtime solo usa node + ffmpeg (lo llama server.mjs); el npm que
# trae node:22-alpine arrastra HIGHs arreglables (pacote, sigstore, ip-address,
# brace-expansion, picomatch) y el gate Trivy de la casa no los deja pasar.
# Se quita tras instalar: nada del runtime lo invoca.
RUN npm ci --omit=dev && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx && mkdir /data && chown node:node /data
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY --from=build /app/public/assistant-ui.generated.js /app/public/assistant-ui.generated.js
COPY --from=build /app/public/assistant-ui.generated.css /app/public/assistant-ui.generated.css
# DL3066 (image-guard, INFRA-540): hadolint rechaza USER con nombre. El usuario
# `node` de node:22-alpine es uid/gid 1000 (addgroup -g 1000 / adduser -u 1000 en
# el Dockerfile oficial de library/node) y la base va fijada por digest arriba,
# así que el UID no puede derivar. Mismo uid/gid que tenía `USER node`.
USER 1000:1000
EXPOSE 3080
CMD ["node", "server.mjs"]
