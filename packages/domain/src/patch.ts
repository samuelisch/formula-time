// Hand-written RFC 6902 JSON Patch for exactly one shape -- RaceState
// (./race_state.ts) -- per ADR-0013 ("Wire" point 1). Never a generic
// json-patch library: top-level scalars get whole-value replace, `drivers`
// is keyed by number with per-field replace (a changed field's whole value
// is the patch, not a further nested diff), `driver_order` / `race_control`
// / `weather` / `anomalies` replace whole when changed. `applyPatch` is
// pure -- it returns a new RaceState and never mutates its input -- so the
// server's round-trip test, and the browser client that applies patches
// from the delta stream, can both call it safely against a state they
// still hold elsewhere.
import type { DriverState, RaceState } from "./race_state.js";

// `structuredClone` is a runtime global in both Node and every current
// browser; the `types: []` / `lib: ["ES2022"]` restriction on this package
// (ADR-0002) just means no lib.dom.d.ts or @types/node ships its
// declaration here, so it is declared locally instead of widening `lib`.
declare function structuredClone<T>(value: T): T;

export interface JsonPatchOp {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

const DRIVER_FIELDS: Array<keyof DriverState> = [
  "driver_number",
  "full_name",
  "name_acronym",
  "team_name",
  "team_colour",
  "position",
  "interval",
  "gap_to_leader",
  "current_lap",
  "lap_duration",
  "sector_durations",
  "is_pit_out_lap",
  "tyre",
  "pit_stops",
  "latest_pit_stop",
  "source_timestamps",
];

/** JSON Pointer escaping (RFC 6901): `~` -> `~0`, `/` -> `~1`. Driver keys are
 * digit strings so this never actually fires today; kept for correctness. */
function escapeSegment(raw: string): string {
  return raw.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapeSegment(raw: string): string {
  return raw.replace(/~1/g, "/").replace(/~0/g, "~");
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    // NaN !== NaN by ===, but no field in RaceState is ever NaN (numberValue
    // returns null instead) -- a plain === miss here means genuinely unequal.
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key) || !deepEqual(aObj[key], bObj[key])) {
      return false;
    }
  }
  return true;
}

/** Diff `prev` -> `next`, both full RaceState snapshots from the same
 * reducer lineage. `[]` when nothing changed (a caller can skip the push). */
export function diffState(prev: RaceState, next: RaceState): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];

  if (prev.sequence !== next.sequence) {
    ops.push({ op: "replace", path: "/sequence", value: next.sequence });
  }
  if (prev.latest_source_time !== next.latest_source_time) {
    ops.push({ op: "replace", path: "/latest_source_time", value: next.latest_source_time });
  }
  if (!deepEqual(prev.session, next.session)) {
    ops.push({ op: "replace", path: "/session", value: next.session });
  }

  for (const key of Object.keys(next.drivers)) {
    const segment = escapeSegment(key);
    const prevDriver = prev.drivers[key];
    const nextDriver = next.drivers[key] as DriverState;
    if (prevDriver === undefined) {
      ops.push({ op: "add", path: `/drivers/${segment}`, value: nextDriver });
      continue;
    }
    for (const field of DRIVER_FIELDS) {
      if (!deepEqual(prevDriver[field], nextDriver[field])) {
        ops.push({ op: "replace", path: `/drivers/${segment}/${field}`, value: nextDriver[field] });
      }
    }
  }
  for (const key of Object.keys(prev.drivers)) {
    if (next.drivers[key] === undefined) {
      ops.push({ op: "remove", path: `/drivers/${escapeSegment(key)}` });
    }
  }

  if (!deepEqual(prev.driver_order, next.driver_order)) {
    ops.push({ op: "replace", path: "/driver_order", value: next.driver_order });
  }
  if (!deepEqual(prev.race_control, next.race_control)) {
    ops.push({ op: "replace", path: "/race_control", value: next.race_control });
  }
  if (!deepEqual(prev.weather, next.weather)) {
    ops.push({ op: "replace", path: "/weather", value: next.weather });
  }
  if (!deepEqual(prev.anomalies, next.anomalies)) {
    ops.push({ op: "replace", path: "/anomalies", value: next.anomalies });
  }

  return ops;
}

/** The inverse of `diffState`, used by the server's round-trip test and by
 * the browser client applying a delta push. The server itself never applies
 * its own patches. Pure: clones `state` first (structuredClone, same
 * primitive `snapshot()` already uses) and mutates only the clone, so the
 * input is never touched. */
export function applyPatch(state: RaceState, ops: JsonPatchOp[]): RaceState {
  const result = structuredClone(state);
  for (const op of ops) {
    applyOp(result, op);
  }
  return result;
}

function applyOp(state: RaceState, op: JsonPatchOp): void {
  const parts = op.path.split("/").slice(1);

  if (parts.length === 1) {
    const [field] = parts as [string];
    switch (field) {
      case "sequence":
        state.sequence = op.value as number;
        return;
      case "latest_source_time":
        state.latest_source_time = op.value as string | null;
        return;
      case "session":
        state.session = op.value as RaceState["session"];
        return;
      case "driver_order":
        state.driver_order = op.value as number[];
        return;
      case "race_control":
        state.race_control = op.value as RaceState["race_control"];
        return;
      case "weather":
        state.weather = op.value as RaceState["weather"];
        return;
      case "anomalies":
        state.anomalies = op.value as RaceState["anomalies"];
        return;
      default:
        throw new Error(`applyPatch: unsupported top-level path "${op.path}"`);
    }
  }

  if (parts[0] === "drivers" && parts.length === 2) {
    const key = unescapeSegment(parts[1] as string);
    if (op.op === "remove") {
      delete state.drivers[key];
    } else {
      state.drivers[key] = op.value as DriverState;
    }
    return;
  }

  if (parts[0] === "drivers" && parts.length === 3) {
    const key = unescapeSegment(parts[1] as string);
    const field = parts[2] as keyof DriverState;
    const driver = state.drivers[key];
    if (driver === undefined) {
      throw new Error(`applyPatch: driver "${key}" missing for field patch "${op.path}"`);
    }
    // `field` is a specific DriverState key but `op.value` (unknown, from
    // the wire) can't be checked against that key's own type at compile
    // time -- a per-field switch mirroring the top-level one above would
    // need no cast, but here it would just be sixteen near-identical cases
    // for one already-unsafe write (the patch's producer, diffState, is
    // this same module, and is what actually keeps them in sync).
    // `unknown` (not `any`) at least stops the value from silently
    // widening at every other use of `driver`.
    (driver as Record<keyof DriverState, unknown>)[field] = op.value;
    return;
  }

  throw new Error(`applyPatch: unsupported path "${op.path}"`);
}
