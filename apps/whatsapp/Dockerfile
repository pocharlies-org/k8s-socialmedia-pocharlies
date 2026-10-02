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
RUN npm ci --omit=dev && mkdir /data && chown node:node /data
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY --from=build /app/public/assistant-ui.js /app/public/assistant-ui.js
COPY --from=build /app/public/assistant-ui.css /app/public/assistant-ui.css
USER node
EXPOSE 3080
CMD ["node", "server.mjs"]
