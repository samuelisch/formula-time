# syntax=docker/dockerfile:1

# One image, two entrypoints (ADR-0001 §1: ingest and api are separate
# services). `.railway/railway.ts` declares both services from this same
# `build.builder: "DOCKERFILE"` and gives each its own `start` command
# (api: node apps/api/dist/main.js; ingest: node apps/ingest/dist/main.js);
# neither service needs a service-specific image.

FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# Runtime stage ships only what the two services need to run: built `dist`
# output, the Prisma schema/migrations/config `migrate deploy` reads at
# deploy time (ADR-0001: migrate-on-deploy runs from this image, so the
# Prisma CLI must be present), and production `node_modules` scoped to the
# api and ingest packages plus their workspace dependencies — never
# TypeScript sources, dev tooling, or apps/web's browser dependencies.
# Runs as a non-root user; invariant: no source files, no devDependencies.
FROM node:24-slim
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
RUN groupadd --system --gid 1001 app \
  && useradd --system --uid 1001 --gid app --home-dir /app --shell /usr/sbin/nologin app
WORKDIR /app
RUN chown app:app /app

# Workspace manifests: pnpm needs every workspace member's package.json to
# resolve the graph against the lockfile, even a member (apps/web) whose own
# dependencies are never installed here.
COPY --chown=app:app package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=app:app apps/api/package.json apps/api/package.json
COPY --chown=app:app apps/ingest/package.json apps/ingest/package.json
COPY --chown=app:app apps/web/package.json apps/web/package.json
COPY --chown=app:app packages/domain/package.json packages/domain/package.json
COPY --chown=app:app packages/db/package.json packages/db/package.json
COPY --chown=app:app scripts/db-env.sh scripts/db-env.sh
COPY --chown=app:app scripts/with-db-env.sh scripts/with-db-env.sh

USER app
# The content-addressable store and pnpm/corepack's own caches are build-time
# scratch, hardlinked into node_modules — removed in this same layer so the
# hardlinked copies survive but the store itself never reaches the image.
RUN pnpm install --prod --frozen-lockfile \
  --filter=@formula-time/api... --filter=@formula-time/ingest... \
  && rm -rf "$(pnpm store path)" /app/.cache

COPY --chown=app:app --from=build /app/apps/api/dist apps/api/dist
COPY --chown=app:app --from=build /app/apps/ingest/dist apps/ingest/dist
COPY --chown=app:app --from=build /app/packages/domain/dist packages/domain/dist
COPY --chown=app:app --from=build /app/packages/db/dist packages/db/dist
COPY --chown=app:app packages/db/prisma packages/db/prisma
COPY --chown=app:app packages/db/prisma.config.ts packages/db/prisma.config.ts

ENV NODE_ENV=production

# No CMD assumes a service. Railway's per-service config overrides this via
# deploy.startCommand; this default is the api entrypoint.
CMD ["node", "apps/api/dist/main.js"]
