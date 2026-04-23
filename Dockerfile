# Multi-stage build for zzapi-mes hub
# Builder: install deps, build all packages, prune to prod node_modules
# Runtime: slim image with only hub dist + production node_modules

FROM node:22-slim AS builder

RUN corepack enable pnpm

WORKDIR /app

# Install build tools for native modules (argon2, better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends g++ python3 && rm -rf /var/lib/apt/lists/*

# Copy workspace config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY apps/hub/package.json apps/hub/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY packages/core/ packages/core/
COPY packages/sdk/ packages/sdk/
COPY packages/cli/ packages/cli/
COPY apps/hub/ apps/hub/
COPY spec/ spec/
RUN pnpm build

# Prune to production dependencies only (keeps native .node binaries)
RUN pnpm prune --prod

# --- Runtime ---
FROM node:22-slim

WORKDIR /app

# Create DB directory and declare as volume for data persistence
RUN mkdir -p /var/lib/zzapi-mes-hub
VOLUME /var/lib/zzapi-mes-hub

# Copy production node_modules and built output from builder
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/sdk/dist/ packages/sdk/dist/
COPY --from=builder /app/packages/sdk/package.json packages/sdk/
COPY --from=builder /app/apps/hub/dist/ apps/hub/dist/
COPY --from=builder /app/apps/hub/package.json apps/hub/
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV HUB_PORT=8080
# HUB_JWT_SECRET — must be set at runtime (docker run -e or compose)
# HUB_DB_PATH — defaults to /var/lib/zzapi-mes-hub/hub.db
# HUB_CORS_ORIGIN — defaults to "*" (any origin); set comma-separated allowlist or "" to disable
# SAP_HOST, SAP_CLIENT, SAP_USER, SAP_PASS — must be set at runtime

EXPOSE 8080

# Run as non-root user
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/healthz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "apps/hub/dist/index.js"]
