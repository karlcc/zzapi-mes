# Multi-stage build for zzapi-mes hub
# Builds from repo root to resolve pnpm workspace dependencies

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

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/core/ packages/core/
COPY packages/sdk/ packages/sdk/
COPY packages/cli/ packages/cli/
COPY apps/hub/ apps/hub/
COPY spec/ spec/

# Build all packages
RUN pnpm build

# --- Runtime ---
FROM node:22-slim

RUN corepack enable pnpm

WORKDIR /app

# Install build tools for native module rebuild
RUN apt-get update && apt-get install -y --no-install-recommends g++ python3 && rm -rf /var/lib/apt/lists/*

# Copy workspace config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY apps/hub/package.json apps/hub/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built output from builder
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/sdk/dist/ packages/sdk/dist/
COPY --from=builder /app/packages/cli/dist/ packages/cli/dist/
COPY --from=builder /app/apps/hub/dist/ apps/hub/dist/

# Remove build tools to reduce image size
RUN apt-get purge -y g++ python3 && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HUB_PORT=8080

EXPOSE 8080

CMD ["node", "apps/hub/dist/index.js"]
