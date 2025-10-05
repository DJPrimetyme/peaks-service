# Small Debian image with Node 20 + ffmpeg available via apt
FROM node:20-bookworm-slim

ENV NODE_ENV=production

# Install ffmpeg and a couple tiny utilities, then clean the cache
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App code
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
