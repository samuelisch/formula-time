# ADR-0022 — Ingest logs through pino; `LOG_LEVEL` joins the config names

Status: Accepted
Date: 2026-09-11
Amends: ADR-0001 (seam 4 config names gain LOG_LEVEL), ADR-0012 (which names ingest's other config names)

## Context

Ingest logged with `console.log`/`console.error` calls built from formatted
strings, while the api logs JSON through Fastify's pino logger. Railway's
log search and the deploy checks that grep for phrases in ingest's output
could not read both services the same way, and a message's counts
(`rows=`, `inserted=`, and so on) lived only inside a free-text string, not
as a field a log query could filter on. A repo quality audit (finding R9)
flagged the console calls across `main.ts`, the writer, and the REST and
MQTT lanes.

## Decision

Ingest logs through pino, pinned as a direct dependency of `apps/ingest`
(the api already pulls it in transitively through Fastify). `src/log.ts`
builds the logger with base fields `service: "ingest"` and `build` (the
deployed commit, from `RAILWAY_GIT_COMMIT_SHA`, or `"unknown"` locally),
JSON output only — no pretty-printing, since Railway already renders JSON
lines fine. The level comes from `LOG_LEVEL`, default `info`.

`LOG_LEVEL` is a seam-4 config name, but unlike the others it is read
directly from `process.env` by `log.ts` rather than threaded through
`config.ts`: it is a logging verbosity knob with a sensible default, never
a secret, and nothing in the ingest pipeline branches on it, so it doesn't
need to be part of the typed config surface the rest of the service reads.

The REST lane, the MQTT lane, and the writer keep their existing
`log(message)` callback — a plain `(message: string) => void`. `main.ts`
wires each one to `logger.info({ lane }, message)`, with `lane` one of
`"rest"`, `"mqtt"`, or `"writer"`, so a log query can filter by lane
without parsing `msg`. A message that carries any of the count names
already in use — `messages=`, `rows=`, `dropped=`, `inserted=`,
`skipped=`, `new=`, `foreign=`, `unknown_session=` — gets those counts
parsed out as structured fields alongside the unchanged `msg`, through one
pure function (`countFields`) that only recognizes integer values for
that fixed set of names. `msg` itself never changes, so nothing that
already greps ingest's log lines for a phrase (the load-race and
operations checks among them) needs to change.

The CLI tools — `sim/`, `load-recording.ts`, `fetch-race.ts` — are
unaffected: they print for a person watching a terminal, not for a log
aggregator, and stay on plain console output.

## Consequences

- An operator can filter Railway's log search by `service`, `lane`, and
  any of the count fields, instead of grepping formatted strings.
- `msg` is unchanged, so existing phrase greps (load-race, operations
  runbook checks) keep working without edits.
- Adding a new count field means adding its name to `countFields`'s fixed
  list in `log.ts`, not inventing an ad hoc field at a call site.
- `console.error` calls for failures are unchanged by this decision —
  `main.ts` (2), `writer/writer.ts` (4), and `openf1/auth.ts` (1, the
  `expires_in` warning) — and are the next candidate for the same logger.
