// Normalizes OpenF1 rows before they join the queue: canonicalizes
// timestamps and strips the MQTT transport envelope inside identity
// hashing, so a REST row and its MQTT twin hash to the same `eventId`
// regardless of lane. The POC reducer's per-row fields (schema_version,
// original_index, out_of_order, duplicate) are dropped: ingest never
// folds, and `events` has no columns for them.

import { createHash } from "node:crypto";

import type { RawRecord } from "./types.js";

export interface EndpointConfig {
  timestampField?: "date" | "date_start";
}

export const endpointConfigs: Record<string, EndpointConfig> = {
  position: { timestampField: "date" },
  laps: { timestampField: "date_start" },
  intervals: { timestampField: "date" },
  pit: { timestampField: "date" },
  race_control: { timestampField: "date" },
  weather: { timestampField: "date" },
  // `overtakes` is one of the eight named MQTT topics — REST's
  // POLL_ROTATION never polls it. Confirmed
  // against a real capture (`../f1-live-events-poc/poc/live-logs/
  // mqtt-probe-2026-09-06T12-57-39-863Z/topics/v1_overtakes.jsonl`): a
  // `date` field, same shape as position/intervals/pit/race_control/weather.
  overtakes: { timestampField: "date" },
  stints: {},
};

// A row's identity must not depend on how a transport spells its timestamps.
// REST emits UTC with an offset ("…+00:00"); OpenF1's MQTT emits the same
// instant with NO offset ("…"). Per JS parsing rules an offset-less ISO
// string would be read as LOCAL time — a different instant — so canonicalize
// any ISO datetime to epoch-ms, treating an offset-less one as UTC (OpenF1
// dates are UTC).
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;
function canonicalizeIso(value: string): string | null {
  if (!ISO_DATETIME.test(value)) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const millis = Date.parse(hasZone ? value : `${value}Z`);
  return Number.isNaN(millis) ? null : `@ts:${millis}`;
}

// Every underscore-prefixed field is transport envelope, not row content:
// MQTT's `_id` (monotonic order) and `_key` (document version), and per the
// 2026 Italian GP capture, sometimes internal fields REST never sends (e.g.
// `stints._date_start_last_lap`). Stripping it here — inside identity — is
// what makes a REST row and its MQTT twin hash to the same `eventId`.
function stripEnvelope(payload: RawRecord): RawRecord {
  const rest: RawRecord = {};
  for (const key of Object.keys(payload)) {
    if (!key.startsWith("_")) rest[key] = payload[key];
  }
  return rest;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  if (typeof value === "string") {
    const canonical = canonicalizeIso(value);
    return JSON.stringify(canonical ?? value);
  }
  return JSON.stringify(value) ?? "null";
}

export function eventId(endpoint: string, payload: RawRecord): string {
  const digest = createHash("sha256")
    .update(stableJson(stripEnvelope(payload)))
    .digest("hex");
  return `${endpoint}:${digest}`;
}

export function timestampValue(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function timestampMillis(value: string | null): number | null {
  return value === null ? null : Date.parse(value);
}

function getNumber(record: RawRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

/** A normalized row, on its way to the writer queue. */
export interface NormalizedRow {
  eventId: string;
  endpoint: string;
  sourceTime: string | null;
  payload: RawRecord;
}

export interface NormalizeResult {
  rows: NormalizedRow[];
  /** Rows that threw while normalizing (e.g. `null`, or anything else `eventId` can't hash) — skipped, not lost to a crash. */
  malformed: number;
  /** `stints` rows whose lap hadn't been seen yet, so `sourceTime` came back null (an out-of-order stint — arrived before its lap row). */
  unjoined: number;
}

// Stateful: dedups by event id across polls (the live API rejects date
// filters, so every poll re-fetches the full endpoint — see README:
// OpenF1 facts) and infers stint start times from laps seen so far. One
// instance per live session.
export class LiveNormalizer {
  private readonly seen = new Map<string, Set<string>>();
  private readonly lapStartByDriverAndLap = new Map<string, string>();

  /**
   * Never throws: a malformed row is caught, skipped, and counted in
   * `malformed`, not lost with every row after it in the batch. An id
   * joins `seen` only once its row is safely in `rows`, so a throw after
   * the id is computed doesn't block a later well-formed retry.
   */
  public normalize(endpoint: string, rows: RawRecord[]): NormalizeResult {
    const config = endpointConfigs[endpoint] ?? {};
    const seen = this.seen.get(endpoint) ?? new Set<string>();
    this.seen.set(endpoint, seen);
    const out: NormalizedRow[] = [];
    let malformed = 0;
    let unjoined = 0;

    for (const payload of rows) {
      try {
        if (endpoint === "laps") {
          const driverNumber = getNumber(payload, "driver_number");
          const lapNumber = getNumber(payload, "lap_number");
          const dateStart = timestampValue(payload["date_start"]);
          if (driverNumber !== null && lapNumber !== null && dateStart !== null) {
            this.lapStartByDriverAndLap.set(`${driverNumber}:${lapNumber}`, dateStart);
          }
        }

        const id = eventId(endpoint, payload);
        if (seen.has(id)) continue;

        let sourceTime: string | null = config.timestampField ? timestampValue(payload[config.timestampField]) : null;

        if (endpoint === "stints") {
          const driverNumber = getNumber(payload, "driver_number");
          const lapStart = getNumber(payload, "lap_start");
          if (driverNumber !== null && lapStart !== null) {
            const lapDate = this.lapStartByDriverAndLap.get(`${driverNumber}:${lapStart}`);
            sourceTime = lapDate ?? null;
            // Only a well-formed stint (both fields present) whose lap
            // genuinely hasn't been seen yet counts as out-of-order; a row
            // missing either field is malformed, not unjoined.
            if (lapDate === undefined) unjoined += 1;
          } else {
            sourceTime = null;
          }
        }

        out.push({ eventId: id, endpoint, sourceTime, payload });
        seen.add(id);
      } catch {
        malformed += 1;
      }
    }
    return { rows: out, malformed, unjoined };
  }
}
