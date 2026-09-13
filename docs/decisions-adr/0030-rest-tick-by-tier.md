# ADR-0030 — REST tick cadence by tier (`REST_TICK_MS`); amends ADR-0012's foreign-session rule and ADR-0029's stats line

Status: Accepted
Date: 2026-09-13
Amends: ADR-0001 (seam 4 config names gain REST_TICK_MS), ADR-0012 (item 3:
a message whose own `session_key` names another session is dropped and
counted as foreign; a message without a `session_key` of its own is still
attributed to the selected session), ADR-0029 (the `ingest: last 60s` line
gains `rest_unjoined`, `mqtt_unjoined`, and `mqtt_foreign`)

## Context

`RestLane` ticks at a fixed 2200 ms regardless of account tier — the free
tier's budget (27 requests/minute at that cadence, POLL_ROTATION's 21
slots). The POC recorder ran a sponsored account at roughly double that
cadence once OpenF1 credentials are present. Ingest's REST lane had no
equivalent: every deployment, sponsored or not, used the free-tier-safe
default, leaving a sponsored deployment polling twice as slowly as its
account allows.

Separately, two MQTT-lane gaps needed the same kind of fix. First, a
`stints` row whose lap hadn't been seen yet got a silent null `sourceTime`
from `LiveNormalizer.normalize` — an out-of-order stint with no visible
signal. Second, the MQTT lane tagged every message to the REST lane's
selected session regardless of what `session_key` the payload itself
carried, so a message naming a different session would silently land on
the wrong one. Both signals belong on ADR-0029's `ingest: last 60s` line
and, for the second, ADR-0012's attribution rule — but ADR-0012 and
ADR-0029 are each Accepted and never edited directly (AGENTS.md,
`check-adr-immutable.sh`); an amendment is how a later ADR extends an
already-accepted one regardless of merge order between the PRs involved.

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

This ADR also amends ADR-0012's Decision item 3: a message whose own
`session_key` disagrees with the REST lane's selected session is dropped
and counted (`mqtt_foreign`) instead of being attributed to it; a message
with no `session_key` of its own keeps ADR-0012's original rule, attributed
to the selected session.

This ADR also amends ADR-0029's Decision §1: the `ingest: last 60s` line
gains `rest_unjoined`, `mqtt_unjoined`, and `mqtt_foreign`. The first two
are the REST lane's and the MQTT lane's own count of `stints` rows whose
`sourceTime` resolved null because their lap hadn't been seen yet —
`LiveNormalizer.normalize`'s `unjoined`. The third is the MQTT lane's count
of messages dropped under the ADR-0012 amendment above. All three are
accumulated by their lane and reset every `takeStats()` call, same as
ADR-0029's other fields.

## Consequences

- A sponsored deployment polls at the cadence its account actually
  allows instead of the free tier's conservative default.
- The free tier still stays under its request budget by default.
- An operator can force a specific cadence for one deployment (testing,
  or a tier not yet modeled) via `REST_TICK_MS` without a code change.
- An out-of-order stint is now visible on the per-minute line instead of
  silent.
- A message tagged to another session is dropped and visible
  (`mqtt_foreign`) instead of silently landing on the wrong session.
- Amending ADR-0012 and ADR-0029 here, instead of editing either directly,
  is immune to merge order between this ADR's PR and each of theirs: once
  an ADR is Accepted on main, a direct edit to it fails the ADR
  immutability check on rebase, while an amendment never touches the
  amended ADR's own file.
