# Image serveur BeninPlay — compatible Oracle Cloud (ARM64) et Fly.io (x64).
# node:20-slim (Debian/glibc) : nécessaire pour les binaires ffmpeg-static.
FROM node:20-slim

WORKDIR /app

# Dépendances d'abord (cache Docker)
COPY package*.json ./
RUN npm ci --omit=dev

# Code
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
