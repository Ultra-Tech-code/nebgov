# Multi-stage build for NebGov Indexer Service
#
# Build strategy: Multi-stage Docker build
# - Builder stage: Installs workspace dependencies and compiles TypeScript from src/ to dist/
# - Production stage: Runs compiled Node.js application with production dependencies only
#
# Build context: Repository root (packages/indexer is part of pnpm workspace)
# Node.js: 20 (from CI sdk.yml and CONTRIBUTING.md requirement)
# pnpm: 9.0.0 (from root package.json packageManager field)
#
# Build: docker build -f packages/indexer/Dockerfile -t nebgov-indexer:latest .
# Run:   docker run --env-file .env nebgov-indexer:latest

# ============================================================================
# Stage 1: Builder
# ============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Enable pnpm via corepack, then prepare pnpm v9.0.0
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copy workspace files (root context) — needed for pnpm workspace resolution
COPY pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy root package.json for workspace context
COPY package.json ./

# Copy indexer package.json
COPY packages/indexer/package.json ./packages/indexer/

# Install all dependencies with workspace resolution (including devDependencies for build)
RUN pnpm install --frozen-lockfile --filter @nebgov/indexer

# Copy indexer source and configuration
COPY packages/indexer/src/ ./packages/indexer/src/
COPY packages/indexer/tsconfig.json ./packages/indexer/

# Build TypeScript → dist/ (using pnpm filter to scope to indexer)
RUN pnpm --filter @nebgov/indexer build

# ============================================================================
# Stage 2: Production
# ============================================================================
FROM node:20-alpine

WORKDIR /app/packages/indexer

# Set production environment
ENV NODE_ENV=production

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copy workspace files from builder
COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/package.json /app/

# Copy indexer package.json
COPY --from=builder /app/packages/indexer/package.json ./

# Install production dependencies only with workspace resolution
RUN cd /app && pnpm install --frozen-lockfile --prod --filter @nebgov/indexer

# Copy compiled code from builder
COPY --from=builder /app/packages/indexer/dist ./dist

# Run as non-root user for security
USER node

# Expose the port the indexer API listens on
EXPOSE 3001

# Health check — checks if indexer is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3001) + '/proposals', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start the indexer service
CMD ["node", "dist/index.js"]
