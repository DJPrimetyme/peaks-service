# Node + Debian 11 (bullseye) because it provides 'audiowaveform' in apt
FROM node:20-bullseye

ENV NODE_ENV=production

# Install audiowaveform + ffmpeg (binary is /usr/bin/audiowaveform)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      audiowaveform ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
