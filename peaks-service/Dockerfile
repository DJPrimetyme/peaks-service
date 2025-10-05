# Use Debian slim with Node 20 (has fetch built-in)
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Tools we need to fetch & unpack the audiowaveform binary
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils tar ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install audiowaveform (prebuilt binary)
ARG AW_VER=1.9.0
RUN set -eux; \
    curl -L -o /tmp/aw.tar.gz \
      https://github.com/bbc/audiowaveform/releases/download/${AW_VER}/audiowaveform-${AW_VER}-Linux-x86_64.tar.gz; \
    tar -xzf /tmp/aw.tar.gz -C /tmp; \
    # find the binary regardless of the extracted folder name
    find /tmp -maxdepth 2 -type f -name audiowaveform -exec mv {} /usr/local/bin/audiowaveform \; ; \
    chmod +x /usr/local/bin/audiowaveform; \
    rm -rf /tmp/aw.tar.gz /tmp/audiowaveform*; \
    audiowaveform -v || true

# App files
COPY package.json ./
RUN npm ci --omit=dev
COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
