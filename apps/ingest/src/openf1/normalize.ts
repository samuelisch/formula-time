// Lifted from `../f1-live-events-poc/poc/ts/normalize_core.ts` (stableJson,
// eventId, timestampValue, timestampMillis, LiveNormalizer, endpointConfigs),
// with the MQTT envelope strip (`../f1-live-events-poc/poc/ts/mqtt_ingest.ts`
// `stripMqttMeta`) folded into identity itself, so a REST row and its MQTT
// twin (T6) hash to the same `eventId` no matter which lane computes it
// first. Everything the POC's reducer needed per row (schema_version,
// original_index, out_of_order, duplicate) is dropped: ingest never folds
// (apps/ingest/AGENTS.md), and the `events` table has no columns for them.

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
  // Review round 2 (PR #105, issue #25): `overtakes` is one of the eight
  // named MQTT topics, and this PR is what turns it on end-to-end for the
  // first time — REST's POLL_ROTATION has never polled it. Confirmed
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
  const digest = createHash("sha256").update(stableJson(stripEnvelope(payload))).digest("hex");
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
}

// Stateful: dedups by event id across polls (the live API rejects date
// filters, so every poll re-fetches the full endpoint — apps/ingest/AGENTS.md)
// and infers stint start times from laps seen so far. One instance per live
// session, same contract as the POC's LiveNormalizer.
export class LiveNormalizer {
  private readonly seen = new Map<string, Set<string>>();
  private readonly lapStartByDriverAndLap = new Map<string, string>();

  /**
   * Never throws: one malformed row (round 4, owner review — e.g. a stray
   * `null` in the response array) must not lose every row after it in the
   * same batch. Each row is normalized in its own try/catch; a row that
   * throws is skipped and counted in `malformed`. An id is added to `seen`
   * only once its row is safely in `rows` — a row that throws AFTER its id
   * was computed but before it landed must not be marked seen, or a later,
   * well-formed retry of that same row would be silently dropped forever.
   */
  public normalize(endpoint: string, rows: RawRecord[]): NormalizeResult {
    const config = endpointConfigs[endpoint] ?? {};
    const seen = this.seen.get(endpoint) ?? new Set<string>();
    this.seen.set(endpoint, seen);
    const out: NormalizedRow[] = [];
    let malformed = 0;

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

        let sourceTime: string | null = config.timestampField
          ? timestampValue(payload[config.timestampField])
          : null;

        if (endpoint === "stints") {
          const driverNumber = getNumber(payload, "driver_number");
          const lapStart = getNumber(payload, "lap_start");
          sourceTime =
            driverNumber !== null && lapStart !== null
              ? (this.lapStartByDriverAndLap.get(`${driverNumber}:${lapStart}`) ?? null)
              : null;
        }

        out.push({ eventId: id, endpoint, sourceTime, payload });
        seen.add(id);
      } catch {
        malformed += 1;
      }
    }
    return { rows: out, malformed };
  }
}
