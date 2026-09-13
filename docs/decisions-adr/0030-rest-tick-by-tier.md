# ADR-0030 — REST lane tick cadence by tier; `REST_TICK_MS` joins the config names

Status: Accepted
Date: 2026-09-13
Amends: ADR-0001 (seam 4 config names gain REST_TICK_MS), ADR-0012

## Context

`RestLane` ticks at a fixed 2200 ms regardless of account tier — the free
tier's budget (27 requests/minute at that cadence, POLL_ROTATION's 21
slots). The POC recorder ran a sponsored account at roughly double that
cadence once OpenF1 credentials are present. Ingest's REST lane had no
equivalent: every deployment, sponsored or not, used the free-tier-safe
default, leaving a sponsored deployment polling twice as slowly as its
account allows.

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

## Consequences

- A sponsored deployment polls at the cadence its account actually
  allows instead of the free tier's conservative default.
- The free tier still stays under its request budget by default.
- An operator can force a specific cadence for one deployment (testing,
  or a tier not yet modeled) via `REST_TICK_MS` without a code change.
