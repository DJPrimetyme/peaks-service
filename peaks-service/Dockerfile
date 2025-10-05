# Dockerfile
FROM node:20-bookworm-slim

# Install audiowaveform and its common deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    audiowaveform ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]

