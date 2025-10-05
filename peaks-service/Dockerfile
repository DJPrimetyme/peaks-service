# Stable Debian base + Node 20
FROM node:20-bookworm

ENV NODE_ENV=production
ENV PORT=3000

# Minimal tools
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# ---- Install audiowaveform (prebuilt static binary) ----
# If a newer version exists, you can bump AW_VER and the URL.
ARG AW_VER=1.9.0
RUN set -eux; \
  curl -L -o /tmp/aw.tar.gz \
    https://github.com/bbc/audiowaveform/releases/download/${AW_VER}/audiowaveform-${AW_VER}-Linux-x86_64.tar.gz; \
  tar -xzf /tmp/aw.tar.gz -C /tmp; \
  mv /tmp/audiowaveform-*/audiowaveform /usr/local/bin/audiowaveform; \
  chmod +x /usr/local/bin/audiowaveform; \
  rm -rf /tmp/audiowaveform-* /tmp/aw.tar.gz; \
  audiowaveform -v || true

# App install
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm i --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
