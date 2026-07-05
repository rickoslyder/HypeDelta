# AI Intelligence Worker (tsx runtime — no fragile ESM dist/)
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages yt-dlp

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY data/ ./data/
COPY src/ ./src/

ENV NODE_ENV=production
CMD ["npx", "tsx", "src/cli.ts", "status"]
