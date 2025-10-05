# ./Dockerfile
FROM node:20-bookworm-slim

# OS deps + audiowaveform with all its runtime libs
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    ca-certificates curl ffmpeg audiowaveform; \
  rm -rf /var/lib/apt/lists/*; \
  audiowaveform -v || true

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

COPY server.js ./server.js

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
