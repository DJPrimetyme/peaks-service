# Debian base so we can apt-get audiowaveform
FROM node:20-bookworm-slim

# Install audiowaveform (and ffmpeg just in case)
RUN apt-get update && \
    apt-get install -y --no-install-recommends audiowaveform ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps (use npm ci if lockfile exists, else npm install)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# Copy the app source
COPY server.js ./

# Environment
ENV NODE_ENV=production
EXPOSE 3000

# Start the service
CMD ["node", "server.js"]

