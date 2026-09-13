# ADR-0030 — REST tick cadence by tier (`REST_TICK_MS`), and `rest_unjoined`/`mqtt_unjoined` on the stats line

Status: Accepted
Date: 2026-09-13
Amends: ADR-0001 (seam 4 config names gain REST_TICK_MS), ADR-0012, ADR-0029
(the `ingest: last 60s` line gains `rest_unjoined` and `mqtt_unjoined`)

## Context

`RestLane` ticks at a fixed 2200 ms regardless of account tier — the free
tier's budget (27 requests/minute at that cadence, POLL_ROTATION's 21
slots). The POC recorder ran a sponsored account at roughly double that
cadence once OpenF1 credentials are present. Ingest's REST lane had no
equivalent: every deployment, sponsored or not, used the free-tier-safe
default, leaving a sponsored deployment polling twice as slowly as its
account allows.

Separately, a `stints` row whose lap hadn't been seen yet got a silent
null `sourceTime` from `LiveNormalizer.normalize` — an out-of-order stint
with no visible signal. ADR-0029's `ingest: last 60s` line is where that
signal belongs, but ADR-0029 is Accepted (or about to be, on its own PR)
and never edited directly (AGENTS.md, `check-adr-immutable.sh`); an
amendment is how a later ADR extends an already-accepted one regardless of
merge order between the two PRs.

## Decision

The REST lane's tick cadence defaults by tier: 2200 ms with no OpenF1
credentials (the free tier's request budget), 1100 ms when both
`OPENF1_LOGIN` and `OPENF1_PASSWORD` are set (matching the POC recorder's
sponsored cadence). `REST_TICK_MS` is a seam-4 config name, read from the
platform secret store like the others, that overrides either tier
default: a positive integer number of milliseconds. An invalid value
(missing is not invalid — it means "no override"; a non-integer, zero, or
negative value is) falls back to the tier default and logs one line at
startup naming the rejected value.

This ADR also amends ADR-0029's Decision §1: the `ingest: last 60s` line
gains `rest_unjoined` and `mqtt_unjoined`. Each is the REST lane's and the
MQTT lane's own count of `stints` rows whose `sourceTime` resolved null
because their lap hadn't been seen yet — `LiveNormalizer.normalize`'s
`unjoined`, accumulated by each lane and reset every `takeStats()` call,
same as ADR-0029's other fields.

## Consequences

- A sponsored deployment polls at the cadence its account actually
  allows instead of the free tier's conservative default.
- The free tier still stays under its request budget by default.
- An operator can force a specific cadence for one deployment (testing,
  or a tier not yet modeled) via `REST_TICK_MS` without a code change.
- An out-of-order stint is now visible on the per-minute line instead of
  silent.
- Amending ADR-0029 here, instead of editing it directly, is immune to
  merge order between this ADR's PR and ADR-0029's own: once ADR-0029 is
  Accepted on main, a direct edit to it would fail the ADR immutability
  check on rebase, while an amendment never touches ADR-0029's file at
  all.
