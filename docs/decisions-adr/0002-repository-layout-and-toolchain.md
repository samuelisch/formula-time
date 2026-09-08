# ADR-0002 — Repository layout and toolchain

- **Status:** Accepted
- **Date:** 2026-09-07
- **Owner:** Samuel Chan
- **Supersedes:** the test-convention rule in `CLAUDE.md` ("plain `tsx`
  assert scripts chained in one npm script").

## Context

ADR-0001 fixes the production shape: an ingest service, an app service,
managed Postgres, static assets on a CDN. The POC is one npm package, one
`tsconfig`, a raw `node:http` server, plain-JS UI with no build step, and
tests as `tsx` assert scripts. Lifting it into this repo forces the layout
questions the POC could ignore.

Three facts drove the decisions below:

- The reducer in `race_state.ts` must run in both Node (live fold) and the
  browser (finished-race replay: scrubbing to any lap means folding the
  event log up to that point). It imports only types, so it is browser-safe.
- Event identity (`eventId` in `normalize_core.ts`) hashes with
  `node:crypto`, so it is Node-only.
- The app service is a singleton with long-lived state (one in-memory fold,
  thousands of open SSE connections, a background poll loop). Request-scoped
  frameworks such as Next.js fight that model.

## Decision

### Layout — pnpm workspaces, separate apps

```
f1-live-events/
  package.json              workspace root: typecheck / test / build for all
  pnpm-workspace.yaml
  tsconfig.base.json
  apps/
    ingest/                 sole OpenF1 consumer: REST + MQTT lanes → Postgres
    app/                    Fastify: authority, SSE fan-out, router, polls
    web/                    Vite + React
  packages/
    shared/                 browser-safe: types, zod wire schemas, reducer
  db/migrations/            numbered SQL files (ADR-0001 seam contract 1)
  docs/adr/
  Dockerfile                one image, two entrypoints (ingest, app)
```

- `packages/shared` may not import any `node:*` module. Event identity and
  normalization stay server-side; whether ingest and app share them is
  decided in track T3, not here.
- No Turborepo / Nx. `pnpm -r` builds in dependency order; revisit only if
  builds get slow.

### Types and validation

- Wire shapes (vote request, poll payload, RaceState as sent over SSE) are
  defined once as zod schemas in `packages/shared`; TypeScript types derive
  from them.
- Runtime validation only where untrusted data enters: OpenF1 rows into
  ingest, and the vote `POST` into the app. The browser imports the
  RaceState type and does not re-validate the SSE payload.

### App service — Fastify, hand-written SSE route

Fastify handles routing, cookies, static files, and validation. The SSE
route is written by hand on the raw response: one gzip stream per
connection, flushed after every push, so the compressor never holds a push
back and the dictionary carries across near-identical states. It is the
load-bearing route and stays under our control.

### Frontend — Vite + React

The POC UI (~1,700 lines of vanilla JS incl. alignment) is ported to React
under Vite. The UI stays deliberately plain in scope; this decision is about
the build and component model, not polish.

### Tests — three tiers

| Tier | Tool | Covers |
|---|---|---|
| Unit | vitest | reducer, poll engine, identity, normalizers; in-memory fakes |
| Integration | vitest + real Postgres in Docker | Postgres fetcher, `ON CONFLICT` dedup, vote upsert. Constraints cannot be proven against a fake |
| End-to-end | Playwright | connect and see the board move; cast a vote and see the tally; delay nudge |

Load, vote-burst, and the drip rehearsal remain scripts, as in the POC.
`typecheck` + unit + integration must pass before a commit.

### Production runtime

Compile with `tsc`; production runs `node` on `dist/`. `tsx` is a dev
dependency only.

## Consequences

- `CLAUDE.md` test rule updated 2026-09-07.
- Three `tsconfig`s (node apps, shared, browser) instead of one; shared
  builds first.
- Integration tests need Docker locally and in CI.
- The port of the UI to React is real work and is scheduled after the
  deploy-first days of ADR-0001, not before; day 1 can ship the vanilla UI
  as static files.
- Dev server: Vite proxies `/api` and the SSE route to the app service.
