# syntax=docker/dockerfile:1

# ---- base: Node 24 + pnpm via corepack ----
# Node 24 is required: auth state uses the built-in `node:sqlite`.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- deps: exact lockfile dependencies ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- build: compile TypeScript to dist/ ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---- runner: production dependencies + dist/ only ----
FROM base AS runner
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist

# OAuth state (auth.db) and the media-link secret live here; mount a volume so
# they survive redeploys. Owned by `node`, the user the process runs as.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" || exit 1

CMD ["node", "dist/main.js"]
