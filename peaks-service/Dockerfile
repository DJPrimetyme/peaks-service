# ./Dockerfile
FROM node:20-bookworm-slim

# Only what we need; ffmpeg includes ffprobe.
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl ffmpeg; \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

COPY server.js ./server.js

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
