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

# Runtime stage copies the whole workspace — node_modules (with
# devDependencies: the `prisma` CLI is one, and `migrate deploy` needs it
# per ADR-0005) and every package's `dist`. Image size is not a goal yet.
FROM node:24-slim
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production

# No CMD assumes a service. Railway's per-service config overrides this via
# deploy.startCommand; this default is the api entrypoint.
CMD ["node", "apps/api/dist/main.js"]
