# FormulaTime

## What this is about

- This is a project on Formula 1 timing visibility, with user interaction on predictions on race results and events. It's a real time polling application with rich data fed from F1TV's source feed, with unique syncing abilities to align race data to the video feed on the same machine.
- Part of a project for JDSG 2026, where we create applications that builds up more intuitive habits on system design archiecture thinking.

## What this project involves

- A timing layer where the user will be able to see rich race data, with granular controls on live replay, with the ability to automatically sync to users' video stream.
- A polling layer where users can predict race state and race results, that resolves and notifies users when those events happen.

## Decisions

- `docs/decisions-adr/` holds every architectural decision, numbered and dated. New decisions are appended.

## Deploy

Railway, two services (`api`, `ingest`) plus a managed `Postgres`, from one
Docker image built from the root `Dockerfile`. Infrastructure is declared in
code, not the (deprecated) `railway.json`/`railway.toml` config-as-code
format: **`.railway/railway.ts`** is the single source of truth for all
three services — `api` (builds from the Dockerfile, runs
`pnpm db:migrate:deploy` as its pre-deploy command, then starts
`node apps/api/dist/main.js`, healthcheck `/health`) and `ingest` (same
build, starts `node apps/ingest/dist/main.js` directly, no pre-deploy step).

Two GitHub Actions workflows apply it, driven by the `railway` CLI via
`railwayapp/config@v1`:

- `.github/workflows/railway-plan.yml` — on every PR touching
  `.railway/**`, posts the diff against the live environment as a PR
  comment. Never applies anything.
- `.github/workflows/railway-apply.yml` — on push to `main` (same path
  filter), applies the plan pinned to the merged PR.

Both need a `RAILWAY_TOKEN` repository secret (a Railway project token) —
the owner adds this once in GitHub repo settings. The first
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
