# F1 Live Events — the deployed app

Public, non-commercial live F1 timing app with race-reactive polls, built
from the validated POC at `../f1-live-events-poc`. Owner is building
backend/system-design depth: surface decisions and trade-offs, don't decide
silently (see their global learning workflow).

## Status (2026-09-07)

Nothing built here yet. The design is decided; the build is sequenced.
Committed decisions live in `docs/adr/` — start with ADR-0001, which holds
the shape, the invariants, the managed-first stance, and the three-day
deploy-first build order with its seam contracts. ADR-0002 fixes the repo
layout and toolchain. The owner is writing presentable docs before
scaffolding: `docs/PRD.md` (draft) is the product spec the design answers to.

## Gain context in this order

1. `docs/adr/0001-production-shape-and-operational-stance.md` — binding.
   Then `docs/adr/0002-repository-layout-and-toolchain.md` — layout
   (pnpm workspaces: `apps/{ingest,app,web}`, `packages/shared`),
   Fastify + hand-written SSE route, Vite + React, tsc for prod.
2. `../f1-live-events-poc/CLAUDE.md` — the POC handoff: architecture,
   commands, hard-won OpenF1 facts (free tier, 404 semantics, mutating rows,
   never two API consumers at once).
3. `docs/PRD.md` (untracked draft) — what and why: goals, non-goals,
   stories v1/v2/later, 5 functional + 4 non-functional requirements,
   open product questions (poll close rule, void rule, headline number).
4. `docs/08-system-designs.md` (untracked draft) — per-component HLD + LLD,
   schema, the eight resolved calls, §8 build order and tracks.
5. `docs/live-architecture-decisions.md` §6.16–6.19 (untracked draft) — the
   reasoning trail behind ADR-0001.
6. `../f1-live-events-poc/poc/ts/` — the code being lifted: `live_race.ts`,
   `session_registry.ts`, `poll_engine.ts` touch no files; the file coupling
   is in `server.ts` behind `Fetcher` in `live_capture.ts`.

## Rules

- The five invariants in ADR-0001 §2 are not negotiable.
- Managed-first: pick the platform's way (secrets, TLS, pooler, restarts)
  over anything hand-rolled.
- New decisions get a new numbered file in `docs/adr/` (Status / Date /
  Context / Decision / Consequences). Never edit an accepted ADR's decision;
  supersede it.
- Tests (ADR-0002): vitest for unit (in-memory fakes) and integration
  (real Postgres in Docker — dedup + vote upsert); Playwright for e2e.
  `typecheck` + unit + integration must pass before a commit.
- `docs/` other than `docs/adr/` is gitignored on purpose — do not change
  `.gitignore` unless asked.
- OpenF1 credentials only via the platform secret store; never in the repo.
- Owner-written tracks: T3 (Postgres fetcher) and T4 (durable votes) are the
  owner's to write under the learning workflow. Plumbing tracks (T1, T2, T5,
  T6) may be delegated to agents.
- Worktree blind spot: untracked `docs/*.md` drafts are invisible inside git
  worktrees. Tickets carry the seam contracts verbatim (ADR-0001 §4).

## Working notes (2026-09-07) — clarified, not yet in any ADR

Vocabulary and mechanics settled in conversation; use these words.

- **Fold** = `Array.reduce` over the event log: start empty, apply events in
  order, the result is RaceState. Live: fold once at startup, apply new
  events as they arrive. Recovery: throw the state away and re-fold. Never
  patch a late event in.
- **Projector / authority.** Class named for what it does
  (`RaceStateProjector`, event-sourcing term); role named for what it
  guarantees ("the authority" — there is exactly one). It "holds" RaceState
  as a plain object in process memory. Derived, disposable, rebuilt from the
  log; votes are not, hence Postgres.
- **Cursor.** The projector remembers the highest `seq` applied and asks
  `WHERE seq > $cursor ORDER BY seq` every 250 ms. Restart = same query with
  cursor 0. Open for T3: two ingest lanes insert concurrently, so a lower
  seq can become visible after a higher one; decide what the cursor does.
- **Push** = RaceState + poll tallies serialized once (`JSON.stringify`),
  the same string written to every socket. A vote never triggers a push; it
  commits a row, changes the in-memory tally, and the next scheduled push
  carries it. Polls are in-process because the tally must be inside the
  string when it is built, and the poll module settles from the fold.
- **Join** = hand the newest existing string, then attach the socket. One
  write, not a new serialization. Every live join is the same; there is no
  separate "mid-race" path. Target adds the last ~30 s of pushes for the
  client delay buffer.
- **Router** = the SSE route handler, ~10 lines: live → attach socket to
  fan-out; finished → redirect to the export. Never touches state. Not a
  box on the HLD.
- **Alignment** is entirely client-side. Browser OCRs the lap counter and
  detects lights-out, derives its offset, and applies it through whatever
  moves the viewer in time: today a server-side seek into the POC's
  per-tab replay session (interim); target a ring buffer of recent pushes
  rendered at now − offset. The only server change was a header line.
- **Rewind tiers.** Seconds back: client ring buffer (target). Minutes/laps
  back: keyframe (RaceState at a lap boundary) + 10 s log chunks fetched
  from object storage and folded in the browser (target); today the
  server-side per-tab session (ADR-0001 call 4, kept for v1).
- **gzip on SSE — compress once, not per connection.** gzip state is per
  connection, so cross-push dictionary gain would cost one compression per
  viewer per push (violates invariant 1). Plan: gzip each push as an
  independent full-flushed block, write the same compressed bytes to all
  sockets, gzip header per connection at join. Ratio is then intra-push
  only — measure on day 1. Browser inflates natively; `EventSource` sees
  plain text; cost ≈1 ms per push. Deltas remain the real egress fix.
- **No CDN needed at first.** Finished-race files may be served by the app;
  CDN is an optimization. But PaaS disks are ephemeral, so exports go to
  the platform's object storage, not local disk.
- **Total laps** is not in OpenF1. POC uses a CLI flag (default 72). Fix if
  needed: a ~24-row circuit → laps table keyed by `circuit_key`, flag as
  override. Whether it is needed depends on the open poll-close question in
  the PRD.
- **Entities.** Stored (one writer each): Event (ingest), Poll, Vote (app).
  Derived in memory: Session, RaceState, Driver (a field inside RaceState,
  not a table), Tally. Transient/files: Viewer (cookie), Push, Export
  (finished race, keyframe, chunk).
- **HLD diagram conventions** (owner's Excalidraw + `08` §0): three process
  boxes (ingest, app, browser); both lanes always on, "safety net" not
  "fallback"; MQTT = same timing rows seconds earlier, telemetry topics
  deliberately not subscribed; REST/MQTT twins have identical ids; arrows
  Polling → Fan-out (tallies ride the push) and Routing → Fan-out (attach
  socket) are required; App → Object storage "export once" is the writer.
