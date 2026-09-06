# F1 Live Events — the deployed app

Public, non-commercial live F1 timing app with race-reactive polls, built
from the validated POC at `../f1-live-events-poc`. Owner is building
backend/system-design depth: surface decisions and trade-offs, don't decide
silently (see their global learning workflow).

## Status (2026-09-07)

Nothing built here yet. The design is decided; the build is sequenced.
Committed decisions live in `docs/adr/` — start with ADR-0001, which holds
the shape, the invariants, the managed-first stance, and the three-day
deploy-first build order with its seam contracts.

## Gain context in this order

1. `docs/adr/0001-production-shape-and-operational-stance.md` — binding.
2. `../f1-live-events-poc/CLAUDE.md` — the POC handoff: architecture,
   commands, hard-won OpenF1 facts (free tier, 404 semantics, mutating rows,
   never two API consumers at once).
3. `docs/08-system-designs.md` (untracked draft) — per-component HLD + LLD,
   schema, the eight resolved calls, §8 build order and tracks.
4. `docs/live-architecture-decisions.md` §6.16–6.19 (untracked draft) — the
   reasoning trail behind ADR-0001.
5. `../f1-live-events-poc/poc/ts/` — the code being lifted: `live_race.ts`,
   `session_registry.ts`, `poll_engine.ts` touch no files; the file coupling
   is in `server.ts` behind `Fetcher` in `live_capture.ts`.

## Rules

- The five invariants in ADR-0001 §2 are not negotiable.
- Managed-first: pick the platform's way (secrets, TLS, pooler, restarts)
  over anything hand-rolled.
- New decisions get a new numbered file in `docs/adr/` (Status / Date /
  Context / Decision / Consequences). Never edit an accepted ADR's decision;
  supersede it.
- Tests follow the POC convention: plain `tsx` assert scripts chained in one
  npm script; `typecheck` + tests must pass before a commit.
- `docs/` other than `docs/adr/` is gitignored on purpose — do not change
  `.gitignore` unless asked.
- OpenF1 credentials only via the platform secret store; never in the repo.
