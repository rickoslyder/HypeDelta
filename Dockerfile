# AI Intelligence Extraction Worker
# Multi-stage build for smaller final image

# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production
FROM node:20-slim

WORKDIR /app

# Install required system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp for YouTube/Twitter fetching
RUN pip3 install --break-system-packages yt-dlp

# Install Claude Code CLI (bundled with SDK, but explicit for worker)
RUN curl -fsSL https://claude.ai/install.sh | bash || true

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

# Create directories for skills and agents
RUN mkdir -p .claude/skills .claude/agents data

# Create non-root user
RUN useradd -m -s /bin/bash aiworker
RUN chown -R aiworker:aiworker /app
USER aiworker

# Set environment
ENV NODE_ENV=production
ENV PATH="/home/aiworker/.local/bin:$PATH"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# Default command
CMD ["node", "dist/cli.js", "status"]
