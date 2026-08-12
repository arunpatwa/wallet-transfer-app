# ---------------------------------------------------------------------------
# Build stage: resolve production dependencies only.
#
# Splitting this out is what keeps the runtime image small -- the npm cache,
# build metadata and devDependencies (vitest and its tree) all stay here and
# never reach the shipped layer.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Copied alone so this layer is cached against the lockfile rather than being
# invalidated by every source edit.
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Runtime stage.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh

# The base image ships an unprivileged `node` user. Running as root would mean a
# process escape starts with root in the container.
USER node

EXPOSE 8080

# Liveness only, matching the application's own split: this asks whether the
# process is alive, not whether the database is reachable, so a database blip
# does not cause the runtime to kill a healthy container.
# wget is part of busybox in Alpine, so this needs no extra package.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
