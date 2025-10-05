# Node + ffmpeg so we can decode audio to PCM
FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
