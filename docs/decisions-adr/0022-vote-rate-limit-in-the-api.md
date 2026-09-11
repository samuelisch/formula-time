# ADR-0022 — Vote rate limit lives in the api, not the platform edge

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-11
- **Owner:** Samuel Chan
- **Amends:** ADR-0001 §3 open call 6 ("Votes | Cookie identity + platform
  edge rate-limit; auth later"). The edge half of that call does not hold
  on the chosen host.

## Context

ADR-0001 §3's operational-stance table picked "cookie identity + platform
edge rate-limit" for votes, on the managed-first premise that the hosting
platform would do the limiting so the api did not have to. Railway applies
no rate limit by default, and the api registers none (`grep -rn
rate-limit apps/api/src` was empty before this change) — repo audit
2026-09-11, finding R6. `POST /api/vote` has no per-client throttle at all:
a script can post votes as fast as Postgres accepts the upsert. Each vote
is still one row per viewer (`votes` primary key `(poll_id, viewer_id)`),
so the exposure is load on the api and Postgres, not tally corruption —
invariant 5 (ADR-0001 §2) already makes a vote real only once its insert
commits, and that holds regardless of request rate.

## Decision

- The api limits `POST /api/vote` itself, since the platform does not.
  `@fastify/rate-limit` (pinned `11.2.0`, compatible with `fastify@5.12.3`
  per the plugin's own compatibility table: `>=10.x` needs `^5.x`) is
  registered only inside the polls plugin (`apps/api/src/polls/routes.ts`),
  with `global: false`, so no route is limited unless it opts in.
- `POST /api/vote` opts in via its own route `config.rateLimit`: 60
  requests per minute, keyed by `request.ip` (the plugin's default
  key generator), one in-memory store — consistent with ADR-0001 §1's one
  api process. Over the limit answers `429 {"error":"rate limited"}`, the
  same error shape as the route's other errors, with the plugin's
  `retry-after` header. `GET /api/live/events`, `GET /api/polls`, the
  `/api/races*` routes and `/health` are untouched.
- `Fastify({ logger: true, trustProxy: true })` in `apps/api/src/main.ts`:
  Railway terminates TLS at its own proxy and forwards the client address
  via `X-Forwarded-For`. Without `trustProxy`, `request.ip` would be the
  proxy's own address for every request, and a per-IP limit would throttle
  every client together instead of individually.
- Measured bound: the 2026-09-08 retro measured "2,000 concurrent votes
  land in about 600 ms with exactly one row per viewer"
  (`docs/retros/2026-09-08-pm.md`) — Postgres's own upsert already absorbs
  a much larger burst than one viewer could ever legitimately produce. 60
  votes per minute per IP is two orders of magnitude above a person's
  re-vote rate (a person re-votes, at most, a handful of times per poll),
  so the limit bounds abusive load without touching normal use.

## Consequences

- The "platform edge rate-limit" half of ADR-0001 §3's open call 6 is
  superseded for votes: the api owns this limit as long as it runs on a
  host that does not provide one. Moving to a platform with an edge limiter
  would make this redundant, not wrong — the api-level limit stays a safe
  floor either way.
- `trustProxy: true` changes `request.ip` (and `request.hostname`) for
  every route, not just `/vote` — any future per-IP logic elsewhere in the
  api inherits the same, correct client address rather than the proxy's.
- A shared IP (NAT, a school or office network) shares one 60-per-minute
  budget across everyone behind it. Accepted: the harm being bounded is
  load, not fairness between voters, and 60/minute is far above what one
  legitimate viewer needs.
- The in-memory store resets on every api restart/redeploy — a client
  rate-limited just before a restart gets a fresh budget after. Acceptable
  for the same reason ADR-0001 accepts an in-process poll-tally cache: one
  process, restart is cheap, and the limit's job is shedding abusive load,
  not enforcing a hard, persistent quota.
