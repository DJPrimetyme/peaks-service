# Minimal Node image
FROM node:20-bookworm-slim

# Install only what we need
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# ---- Install audiowaveform prebuilt binary ----
# IMPORTANT: releases are under /download/vX.Y.Z/ (note the "v")
ARG AW_VER=1.9.0
ARG AW_TAG=v1.9.0
RUN set -eux; \
  curl -L -o /tmp/aw.tar.gz "https://github.com/bbc/audiowaveform/releases/download/${AW_TAG}/audiowaveform-${AW_VER}-Linux-x86_64.tar.gz"; \
  tar -xzf /tmp/aw.tar.gz -C /tmp; \
  # the folder name inside the tar can vary slightly; find the binary and place it on PATH
  find /tmp -maxdepth 2 -type f -name audiowaveform -exec mv {} /usr/local/bin/audiowaveform \; ; \
  chmod +x /usr/local/bin/audiowaveform; \
  rm -rf /tmp/aw.tar.gz /tmp/audiowaveform*; \
  audiowaveform -v || true

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

COPY server.js ./server.js

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
