# Multi-stage build for NebGov Backend API
#
# Build strategy: Multi-stage Docker build
# - Builder stage: Compiles TypeScript from src/ to dist/ using tsc
# - Production stage: Runs compiled Node.js application with production dependencies only
#
# Node.js: 20 (from CI sdk.yml and CONTRIBUTING.md requirement)
# pnpm: 9.0.0 (from root package.json packageManager field)
#
# Build: docker build -f backend/Dockerfile -t nebgov-backend:latest ./backend
# Run:   docker run -p 3001:3001 --env-file .env nebgov-backend:latest

# ============================================================================
# Stage 1: Builder
# ============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Enable pnpm via corepack, then prepare pnpm v9.0.0
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copy package.json and lockfile (backend is standalone, not part of workspace)
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies needed for build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Build TypeScript → dist/
RUN pnpm build

# ============================================================================
# Stage 2: Production
# ============================================================================
FROM node:20-alpine

WORKDIR /app

# Set production environment (prevents dev-only installs)
ENV NODE_ENV=production

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copy package.json and lockfile from builder stage
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy compiled code from builder
COPY --from=builder /app/dist ./dist

# Copy database migration files if needed
COPY src/db/schema.sql ./src/db/ || true

# Run as non-root user for security (builtin node user)
USER node

# Expose the port the backend listens on
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3001) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start the backend server
CMD ["node", "dist/index.js"]

