# ADR-0023 — The Prisma CLI is a runtime dependency of packages/db

Status: Proposed (accepted when the owner merges)
Date: 2026-09-11
Amends: ADR-0005 Consequences ("The deploy step that runs `prisma migrate
deploy` needs the `prisma` CLI installed (a devDependency)")

Number: 0023 is the next free ADR number as of this PR. `origin/main`'s
highest is 0021. Two other open PRs each add an `0022` (issue #223's vote
rate-limit PR #234, and issue #226's ingest structured-logging PR #231) —
already a collision between those two — so this file takes 0023 rather
than add a third claimant to 0022.

## Context

Issue #224's repo audit (2026-09-11, finding R7) found the Dockerfile's
runtime stage was `COPY --from=build /app /app`: the production image
carried TypeScript sources and every devDependency, and ran as root. The
fix trims the runtime stage to `dist` output and production `node_modules`
scoped to `apps/api` and `apps/ingest`, non-root.

`pnpm db:migrate:deploy` (`prisma migrate deploy`) is Railway's pre-deploy
command for the `api` service (ADR-0001, migrate-on-deploy) and runs
*inside this image* on every deploy. A production-only install no longer
carries devDependencies, so a CLI that stays a devDependency would not
reach the running container — migrate-on-deploy would break. ADR-0005's
Consequences section named the CLI a devDependency; that line is now
false regardless of PR outcome, and needs a record, not a paraphrase.

## Decision

`prisma` is a `dependencies` entry of `packages/db`, pinned at the version
already in use (`7.10.0`, unchanged by this move). Nothing else moves from
devDependencies to dependencies: the runtime image still installs
production dependencies only, scoped to `apps/api` and `apps/ingest` and
their workspace dependencies (`packages/db`, `packages/domain`).

## Consequences

- The runtime image now carries the Prisma CLI's own dependency tree
  (notably `@prisma/studio-core`, `@prisma/dev` and its bundled
  `@electric-sql/pglite`, and `typescript`) even though none of it runs at
  deploy time — `prisma migrate deploy` is the only CLI command this image
  ever invokes. Measured on issue #224's branch: the trimmed image is
  868MB against a 1.15GB before-image that carried every devDependency for
  all six workspace packages; the Prisma CLI's tree is a sizeable fraction
  of what remains.
- `pnpm audit --prod` against the runtime image lists 3 advisories (2
  high, 1 moderate: `deepmerge-ts`, `mysql2`) transitive through `prisma`'s
  own `@prisma/config`/database-driver detection — present before this
  ADR's image (as a devDependency) and unchanged by the move.
- A future move of migrations out of the deploy step (a separate
  migrate-only image or job, or a managed migration mechanism) would let
  `prisma` return to `packages/db`'s devDependencies and drop this whole
  tree from the runtime image.
