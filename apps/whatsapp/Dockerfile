FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY assistant ./assistant
COPY vite.config.mjs ./
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production TZ=Europe/Madrid
WORKDIR /app
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
USER node
EXPOSE 3080
CMD ["node", "server.mjs"]
