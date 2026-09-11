# FormulaTime

## What this is about

- This is a project on Formula 1 timing visibility, with user interaction on predictions on race results and events. It's a real time polling application with rich data fed from F1TV's source feed, with unique syncing abilities to align race data to the video feed on the same machine.
- Part of a project for JDSG 2026, where we create applications that builds up more intuitive habits on system design archiecture thinking.

## What this project involves

- A timing layer where the user will be able to see rich race data, with granular controls on live replay, with the ability to automatically sync to users' video stream.
- A polling layer where users can predict race state and race results, that resolves and notifies users when those events happen.

## Decisions

- `docs/decisions-adr/` holds every architectural decision, numbered and dated. New decisions are appended.

## Local ports

`scripts/db-env.sh` hashes `git rev-parse --show-toplevel` into a
`COMPOSE_PROJECT_NAME` and three ports — `DB_PORT`, `API_PORT`, `WEB_PORT` —
so each worktree gets its own compose project, its own Postgres host port,
and its own api and web dev ports; two worktrees can run
`pnpm test:integration` or rehearse a race at the same time without sharing a
database or fighting over a port. A plain checkout (not under
`.claude/worktrees/`) always gets `DB_PORT` 5433, `API_PORT` 3000, `WEB_PORT`
5173, matching the rest of this repo's docs; other worktrees land in
5440-5489, 3000-3199, and 5173-5372 respectively — the three ranges never
overlap. Override any of the three by exporting it yourself before running a
script — e.g. `DB_PORT=<port>` wins if the computed port collides with
something else already listening.

`pnpm db:up` / `pnpm db:down` / `pnpm db:migrate:dev` / `pnpm db:migrate:deploy`
/ `pnpm test:integration` run through `scripts/with-db-env.sh`, which exports
`scripts/db-env.sh`'s values plus a `DATABASE_URL`/`DATABASE_DIRECT_URL`
default derived from `DB_PORT`; `db:up`/`db:down` only ever touch their own
worktree's containers. `pnpm dev:api` and `pnpm dev:web` run through the same
script so the api picks up its worktree's `API_PORT` and the web dev server
picks up `WEB_PORT` (and proxies to the right `API_PORT`).

## Deploy

A release happens only on push to the `release` branch (ADR-0019); push to
`main` never deploys anything on Railway or on Netlify. `main` is the
always-CI-green integration branch. Shipping a release is the `release`
skill (`.claude/skills/release/SKILL.md`): from any checkout, once
`gh run list --branch main --limit 1` shows CI green,
`git fetch origin && git push origin origin/main:release` — a
fast-forward, never a merge, never a direct commit on `release`.
`.github/workflows/release.yml` then reuses `ci.yml`'s gate (the same
checks a PR already passed) and runs a `smoke` job that waits for both
deploys and confirms each serves traffic; a failed smoke job is red on the
release commit and does not roll anything back.

Railway, two services (`api`, `ingest`) plus a managed `Postgres`, from one
Docker image built from the root `Dockerfile`. Infrastructure is declared in
code, not the (deprecated) `railway.json`/`railway.toml` config-as-code
format: **`.railway/railway.ts`** is the single source of truth for all
three services — `api` (builds from the Dockerfile, runs
`pnpm db:migrate:deploy` as its pre-deploy command, then starts
`node apps/api/dist/main.js`, healthcheck `/health`) and `ingest` (same
build, starts `node apps/ingest/dist/main.js` directly, no pre-deploy step).
Both read their source from the `release` branch.

Two GitHub Actions workflows apply it, driven by the `railway` CLI via
`railwayapp/config@v1`:

- `.github/workflows/railway-plan.yml` — on every PR touching
  `.railway/**`, posts the diff against the live environment as a PR
  comment. Never applies anything.
- `.github/workflows/railway-apply.yml` — on push to `release` (same path
  filter), applies the plan pinned to the merged PR that last touched
  `.railway/**`.

The web bundle is built and hosted by Netlify from `apps/web` on push to
`release`; deploy previews and branch deploys are off, so a PR no longer
gets its own Netlify preview link. Netlify's build command, publish
directory, production branch (`release`), deploy previews (off) and
branch deploys (off) are site settings in the dashboard (Site
configuration -> Build & deploy); nothing in the repo configures Netlify.

Both Railway workflows need a `RAILWAY_TOKEN` repository secret (a Railway
project token) — the owner adds this once in GitHub repo settings. The first
`railway config plan` is run locally by the owner, to confirm it reads as
*adopting* the three already-provisioned services (`api`, `ingest`,
`Postgres` — check the `Postgres` image/version in the diff carefully) and
not deleting or recreating any of them, before anyone runs `apply`.

Variables (`DATABASE_URL`, `DATABASE_DIRECT_URL`, `OPENF1_LOGIN`,
`OPENF1_PASSWORD`) are declared in `.railway/railway.ts`: the two database
URLs are typed references to the `Postgres` service, and the two OpenF1
secrets use `preserve()` so their already-set dashboard values are kept —
no secret value ever enters the repo. Railway injects `PORT` itself.

Check the SSE route through Railway's proxy once deployed:

```
curl -N https://<api-domain>/live/events
```

A `heartbeat` event should print every 5 seconds, unbuffered.
