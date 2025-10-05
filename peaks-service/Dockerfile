# ./Dockerfile
FROM node:20-bookworm-slim

# OS deps + runtime libs required by audiowaveform
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    ca-certificates curl ffmpeg libsndfile1 libgd3; \
  rm -rf /var/lib/apt/lists/*

# Install prebuilt audiowaveform binary (no APT pkg in Bookworm)
ARG AW_VER=1.9.0
ARG AW_TAG=v1.9.0
RUN set -eux; \
  curl -L -o /tmp/aw.tar.gz "https://github.com/bbc/audiowaveform/releases/download/${AW_TAG}/audiowaveform-${AW_VER}-Linux-x86_64.tar.gz"; \
  tar -xzf /tmp/aw.tar.gz -C /tmp; \
  find /tmp -type f -name audiowaveform -exec mv {} /usr/local/bin/audiowaveform \; ; \
  chmod +x /usr/local/bin/audiowaveform; \
  /usr/local/bin/audiowaveform -v || true; \
  rm -rf /tmp/aw.tar.gz /tmp/audiowaveform*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

COPY server.js ./server.js

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
