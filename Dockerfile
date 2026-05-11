# Multi-stage build for Sketch
# Targets linux/arm64 (Graviton Fargate) but builds on any platform.

# ── Stage 1: Build ────────────────────────────────────────────────
FROM node:24-slim AS build

ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Copy workspace config first for better layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/

RUN pnpm install --frozen-lockfile

# Copy source and build
COPY packages/ packages/
COPY tsconfig.base.json ./

RUN pnpm -r build && cp -r packages/web/dist packages/server/dist/public

# Prune dev dependencies for the runtime image
RUN pnpm --filter @sketch/server deploy --prod --legacy /app/pruned

# ── Stage 2: Runtime ──────────────────────────────────────────────
FROM node:24-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends git gh python3 python3-pip python3-venv ca-certificates chromium fonts-liberation && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only the bundled output and production node_modules
COPY --from=build /app/pruned/node_modules ./node_modules
COPY --from=build /app/packages/server/dist ./dist

RUN printf '%s\n' '#!/bin/sh' 'exec /app/node_modules/.bin/md-to-pdf "$@"' > /usr/local/bin/md-to-pdf \
  && printf '%s\n' '#!/bin/sh' 'exec /app/node_modules/.bin/md2pdf "$@"' > /usr/local/bin/md2pdf \
  && chmod +x /usr/local/bin/md-to-pdf /usr/local/bin/md2pdf

# Create data directory writable by the runtime user
RUN mkdir -p /app/data && chown 1000:1000 /app/data

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
EXPOSE 3000

USER 1000

ENTRYPOINT ["node", "dist/index.js"]
