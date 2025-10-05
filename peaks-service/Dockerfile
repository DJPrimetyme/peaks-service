# Simple, stable image with ffmpeg available
FROM node:20-bookworm-slim

# Install ffmpeg for decoding; keep the image small
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps (use lockfile if present)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

# Copy the service
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
