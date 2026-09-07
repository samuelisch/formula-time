# ADR-0001 — Production shape, operational stance, and build order

- **Status:** Accepted
- **Date:** 2026-09-07
- **Owner:** Samuel Chan
- **Supersedes:** nothing — first committed entry. Distils the draft decision
  log (`docs/live-architecture-decisions.md` §6.17–6.19, untracked) and the
  draft system designs (`docs/08-system-designs.md`, untracked).

## Context

The POC (`../f1-live-events-poc`) is one Node process, validated live on two
real races (2026 Dutch GP, 2026 Italian GP — red flags, safety car, standing
restart), load-tested to 8,000 synthetic SSE clients, with a race-reactive
poll layer, rewind-during-live, a drip simulator, broadcast alignment, and a
tested MQTT ingest adapter. It reads OpenF1 via a recorder that appends
jsonl files; the server tails those files. Votes live in an in-memory `Map`.

This repo is the deployed, public, non-commercial app built from that POC.
The owner is training backend/system-design depth; the architecture is the
learning target, operations are not.

## Decision

### 1. Shape — two services + managed Postgres + static files

- **Ingest service** — the ONLY process that talks to OpenF1. Two lanes
  always on: REST (cadence unchanged from the POC) and MQTT (named timing
  topics only, never `v1/#`; exactly one connection; re-subscribe on every
  `connect`). Both lanes write through one path:
  `INSERT INTO events … ON CONFLICT (event_id) DO NOTHING`. No failover
  logic — the constraint is the dedup. Separate service because its
  lifecycle differs (alive around sessions) and it must survive app restarts.
- **App service** — authority (fold the log → race state), serialize-once
  SSE fan-out, thin router (decides at connect: live stream / snapshot then
  stream / finished-race export), and polls as an in-process module (tallies
  ride the same payload). One service, not four.
- **Postgres (managed)** — the log's home: `events` (PK `event_id`,
  `seq bigserial` cursor), `polls`, `votes` (PK `(poll_id, viewer_id)`).
  Ingest is the only writer of `events`; the app is the only writer of
  `polls`/`votes`.
- **Static assets** on the platform CDN; finished races exported once to an
  immutable file the browser folds itself.

### 2. Invariants (violate any and the system stops scaling)

1. One shared serialize-once stream per live race; viewer delay (broadcast
   alignment) is a client concern, never per-viewer server work.
2. The database is touched per event (one write) and per join (one read) —
   never per viewer per tick.
3. Row identity is transport-independent: canonicalize ISO timestamps to
   epoch-ms (offset-less = UTC), strip every `_`-prefixed vendor field, hash.
   REST and MQTT twins dedup to one row at one point.
4. Never patch late events into running state; rebuild from the log.
5. Anything with stakes (votes, settlement) settles server-side, never in
   the browser. A vote is acknowledged only after its insert commits.

### 3. Operational stance — managed-first

Two axes, kept separate. *What is built* is the whole design above (deltas
and browser-side fold included, in sequence) — no component skipped. *How
each piece is set up and run* is always the managed, lowest-friction option:

| Call | Resolution |
|---|---|
| Ingest trigger | Always-on self-discovering worker; crash-restart by the platform |
| Postgres | Managed (pooler, backups, PITR included) |
| Authority wake-up | 250 ms poll on `seq` (LISTEN/NOTIFY breaks behind transaction-mode poolers) |
| Deep rewind on live | Keep the POC's server-side interim session; browser fold is the target |
| Payload | gzip now; deltas are the next build step after first deploy |
| Votes | Cookie identity + platform edge rate-limit; auth later |
| Alignment | Auto-align flagship, manual delay nudge as the floor; client-side only |
| Hosting | PaaS (Fly.io / Render / Railway) + its managed Postgres; git-push deploy, TLS, secrets |

Trade accepted: money for operational toil.

### 4. Build order — deploy-first, agent-parallel

Seam contracts are pinned first and copied verbatim into every ticket:
schema; `type Fetcher = (url: string) => Promise<unknown>` (unchanged from
the POC — the Postgres fetcher answers the same virtual URLs the file
fetcher does); table ownership; config names (`DATABASE_URL`,
`OPENF1_LOGIN`/`OPENF1_PASSWORD`, `PORT`, `LIVE_SOURCE`) from the platform
secret store; vote acknowledgement after commit.

- **Day 1 — deploy.** Platform + managed Postgres. Schema/migrations, durable
  votes, Dockerfile + platform config, gzip. Ship the POC with durable votes.
  Verify: `curl -N` shows an unbuffered SSE stream; a vote survives restart.
- **Day 2 — events into Postgres.** Ingest writer + Postgres fetcher behind
  the seam; jsonl files still written (the recording is the irreplaceable
  artefact).
- **Day 3 — second lane + rehearsal.** MQTT lane; full drip-simulator run
  against the *deployed* stack, both lanes on, forced ingest restart mid-run.
- **Soak** until the next live session — that session is the proof.

Two finish lines, on purpose: *deployed and rehearsed* (day 1–3) and
*proven* (next live session). The owner reviews the two design-bearing
tracks personally (Postgres fetcher; vote acknowledgement semantics); the
plumbing tracks are delegated.

## Consequences

- Egress and full-state payload size (~85 KB × viewers × ~4/s) make deltas
  the first post-deploy build item, not an option.
- SSE through the platform proxy is the first thing verified on a live URL;
  the heartbeat is load-bearing.
- Token lifecycle (3600 s bearer, refresh before expiry, on every
  reconnect) must hold for days, not hours — unproven until the soak.
- Recorder restart mid-session is unverified in the POC; day 3 forces it.
- OpenF1 non-commercial terms become public-facing: visible OpenF1 credit,
  no F1 branding.
- Anything in `docs/` other than `docs/adr/` is an untracked draft by choice.

## References

- POC: `../f1-live-events-poc` (read its `CLAUDE.md` first; `docs/` there
  holds the fan-out decisions, load-test and live-session findings).
- Drafts (untracked): `docs/README.md` reading order, `docs/08-system-designs.md`.
