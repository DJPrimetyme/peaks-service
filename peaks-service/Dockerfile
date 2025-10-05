# Use Ubuntu 22.04 (Jammy) so apt can install audiowaveform
FROM node:20-jammy

ENV NODE_ENV=production
ENV PORT=3000

# Install tools + audiowaveform (and ffmpeg just in case)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg software-properties-common audiowaveform \
 && rm -rf /var/lib/apt/lists/*

# App
WORKDIR /app
COPY package*.json ./
RUN npm i --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
