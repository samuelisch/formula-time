# ADR-0012 — MQTT lane: exactly one connection, `MQTT_ENABLED` joins the config names

Status: Accepted
Date: 2026-09-09
Amends: ADR-0001 (§1 "two lanes always on, no failover logic": the MQTT lane is on whenever OpenF1 credentials exist and off when they do not, because the free tier has no MQTT; this is a deployment fact, not failover logic. Seam 4 config names gain MQTT_ENABLED)

## Context

ADR-0007 says both ingest lanes feed one queue and one connection. The MQTT lane (issue #25) needs a switch: OpenF1's free tier has no MQTT access, so an unauthenticated deployment must not open a broker connection that can only fail.

## Decision

1. `MQTT_ENABLED` is a seam-4 config name, read from the platform secret store like the others. Default: `true` when `OPENF1_LOGIN` is set, otherwise `false`.
2. The lane holds exactly one broker connection at any time; a reconnect replaces it, never adds one. Re-subscribe to the eight named timing topics on every `connect`; never `v1/#`.
3. Messages are attributed to the session the REST lane has selected; a message with no selected session is dropped and counted. The REST lane stays the authority on which session is live.

## Consequences

- The real broker is exercised only by the day-3 rehearsal (ADR-0001 §4); until then the CONNACK rejection codes the lane treats as auth failures (MQTT 3.1.1 codes 4 and 5, MQTT 5 0x86 and 0x87) are unverified.
- Turning the lane off is a config change, not a deploy.
- With credentials set, MQTT_ENABLED=false is an operator override for incidents only; the deployed default is both lanes on.
