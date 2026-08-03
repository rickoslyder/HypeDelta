# HypeDelta worker — immutable multi-stage production image
# Typechecks + esbuild-bundles scheduler → dist/worker.js and CLI → dist/cli-worker.js.
# Runtime copies full dist/; CMD remains node dist/worker.js as non-root.
# No secrets. No source bind mount required at runtime.

# -----------------------------------------------------------------------------
# Stage 1: install all deps (including devDeps needed to compile)
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 2: typecheck + bundle runnable worker + operational CLI entrypoints
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=deps /app/apps/web/package.json ./apps/web/
COPY tsconfig.json ./
COPY src ./src
COPY data/sources.json ./data/sources.json

RUN pnpm run build:worker

# -----------------------------------------------------------------------------
# Stage 3: production runtime
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Runtime OS deps for fetchers / Agent SDK helpers:
# ffmpeg (media), python3 + pinned yt-dlp (YouTube / video sources)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    python3-pip \
  && pip3 install --break-system-packages --no-cache-dir yt-dlp==2026.7.4 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Root package only — do not copy workspace layout (avoids installing apps/web).
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod \
  && pnpm store prune

COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node data/sources.json ./data/sources.json
COPY --chown=node:node .claude ./.claude

# Writable digest output dir; owned by node without recursive /app rewrite
RUN install -d -o node -g node /app/data/digests

USER node

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD ["node", "dist/worker-healthcheck.js"]

CMD ["node", "dist/worker.js"]
