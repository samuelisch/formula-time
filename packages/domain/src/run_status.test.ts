import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createInitialState, RaceStateReducer } from "./race_state.js";
import type { DriverState, RaceState } from "./race_state.js";
import type { RawRecord } from "./types.js";
import { runStatus } from "./run_status.js";

function driver(overrides: Partial<DriverState> & { driver_number: number }): DriverState {
  return {
    driver_number: overrides.driver_number,
    full_name: null,
    name_acronym: null,
    team_name: null,
    team_colour: null,
    position: null,
    interval: null,
    gap_to_leader: null,
    current_lap: null,
    lap_duration: null,
    sector_durations: { sector_1: null, sector_2: null, sector_3: null },
    is_pit_out_lap: null,
    tyre: { stint_number: null, compound: null, lap_start: null, lap_end: null, age_at_start: null, age: null },
    pit_stops: [],
    latest_pit_stop: null,
    source_timestamps: {},
    ...overrides,
  };
}

function stateOf(drivers: DriverState[]): RaceState {
  const byNumber: Record<string, DriverState> = {};
  for (const one of drivers) byNumber[String(one.driver_number)] = one;
  const driverOrder = drivers
    .filter((one) => one.position !== null)
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
    .map((one) => one.driver_number);

  return {
    sequence: 0,
    latest_source_time: null,
    session: null,
    drivers: byNumber,
    driver_order: driverOrder,
    race_control: {
      session_status: null,
      current_flag: null,
      safety_car: null,
      active_flags: {},
      driver_flags: {},
      recent_messages: [],
    },
    weather: null,
    anomalies: { duplicate_events: 0, stale_updates: 0, missing_driver: 0, unsupported_events: 0 },
  };
}

describe("runStatus (hand-built states)", () => {
  it("keeps everyone running before the leader reaches lap 2", () => {
    const leader = driver({ driver_number: 1, position: 1, current_lap: 1 });
    const noLapYet = driver({ driver_number: 2, position: null, current_lap: null });
    const state = stateOf([leader, noLapYet]);

    expect(runStatus(state, 1)).toBe("running");
    expect(runStatus(state, 2)).toBe("running");
  });

  it("marks a driver with no lap row dns once the leader reaches lap 2", () => {
    const leader = driver({ driver_number: 1, position: 1, current_lap: 2 });
    const neverStarted = driver({ driver_number: 2, position: null, current_lap: null });
    const state = stateOf([leader, neverStarted]);

    expect(runStatus(state, 2)).toBe("dns");
  });

  it("marks a driver dnf when 3+ laps down and its last intervals row predates the leader's lap start", () => {
    const leader = driver({
      driver_number: 1,
      position: 1,
      current_lap: 10,
      source_timestamps: { lap: "2026-01-01T00:10:00Z" },
    });
    const stale = driver({
      driver_number: 2,
      position: 2,
      current_lap: 7,
      source_timestamps: { intervals: "2026-01-01T00:05:00Z" },
    });
    const state = stateOf([leader, stale]);

    expect(runStatus(state, 2)).toBe("dnf");
  });

  it("keeps a 3+-laps-down driver running when its intervals row is fresher than the leader's lap start", () => {
    const leader = driver({
      driver_number: 1,
      position: 1,
      current_lap: 10,
      source_timestamps: { lap: "2026-01-01T00:10:00Z" },
    });
    const fresh = driver({
      driver_number: 2,
      position: 2,
      current_lap: 7,
      source_timestamps: { intervals: "2026-01-01T00:10:05Z" },
    });
    const state = stateOf([leader, fresh]);

    expect(runStatus(state, 2)).toBe("running");
  });

  it("keeps a driver only 2 laps down running even with a stale intervals row", () => {
    const leader = driver({
      driver_number: 1,
      position: 1,
      current_lap: 10,
      source_timestamps: { lap: "2026-01-01T00:10:00Z" },
    });
    const twoDown = driver({
      driver_number: 2,
      position: 2,
      current_lap: 8,
      source_timestamps: { intervals: "2026-01-01T00:05:00Z" },
    });
    const state = stateOf([leader, twoDown]);

    expect(runStatus(state, 2)).toBe("running");
  });

  it("falls back to running when no driver holds position 1", () => {
    const noLeaderA = driver({ driver_number: 1, position: null, current_lap: 10 });
    const noLeaderB = driver({
      driver_number: 2,
      position: null,
      current_lap: 13,
      source_timestamps: { intervals: "2026-01-01T00:00:00Z" },
    });
    const state = stateOf([noLeaderA, noLeaderB]);

    expect(runStatus(state, 1)).toBe("running");
  });

  it("returns running for a driver number with no DriverState at all", () => {
    const leader = driver({ driver_number: 1, position: 1, current_lap: 5 });
    const state = stateOf([leader]);

    expect(runStatus(state, 99)).toBe("running");
  });
});

// Real recordings, gitignored, symlinked into the worktree for this run.
// Skipped, loudly, when the symlink/directory isn't present.
const RECORDINGS_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../../recordings");
const ITALY_DIR = path.join(RECORDINGS_DIR, "11361");
const NETHERLANDS_DIR = path.join(RECORDINGS_DIR, "11353");

// Each raw line is a capture envelope, `{ received_at, payload }`; the fold
// only cares about `payload`.
function loadJsonl(filePath: string): RawRecord[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { payload: RawRecord }).payload);
}

// Only the endpoints runStatus's rule reads: position (leader lookup, via
// driver_order), laps (current_lap, source_timestamps.lap), intervals
// (source_timestamps.intervals). Each raw file is already in capture
// (chronological) order per driver/field, and acceptField only ever compares
// a field to its own previous value, so folding one endpoint file at a time,
// in any order relative to the others, still yields the correct final state.
const RUN_STATUS_ENDPOINTS: Array<{ endpoint: string; file: string; timestampField: string }> = [
  { endpoint: "position", file: "position.jsonl", timestampField: "date" },
  { endpoint: "laps", file: "laps.jsonl", timestampField: "date_start" },
  { endpoint: "intervals", file: "intervals.jsonl", timestampField: "date" },
];

function foldRecording(dir: string): RaceState {
  const reducer = new RaceStateReducer(createInitialState({ sessions: [], drivers: [] }));

  for (const { endpoint, file, timestampField } of RUN_STATUS_ENDPOINTS) {
    const rows = loadJsonl(path.join(dir, "raw", file));
    rows.forEach((payload, index) => {
      const rawTimestamp = payload[timestampField];
      const sourceTime = typeof rawTimestamp === "string" ? rawTimestamp : null;
      reducer.apply({
        event_id: `${endpoint}-${index}`,
        endpoint,
        source_time: sourceTime,
        payload,
      });
    });
  }

  return reducer.snapshot();
}

function dnfDriverNumbers(state: RaceState): number[] {
  return Object.values(state.drivers)
    .filter((one) => runStatus(state, one.driver_number) === "dnf")
    .map((one) => one.driver_number)
    .sort((left, right) => left - right);
}

describe.skipIf(!existsSync(ITALY_DIR))("runStatus (2026 Italian GP recording, 11361)", () => {
  it("marks drivers 14, 16 and 18 dnf at the final folded state", () => {
    const state = foldRecording(ITALY_DIR);
    expect(dnfDriverNumbers(state)).toEqual([14, 16, 18]);
  });
});

describe.skipIf(!existsSync(NETHERLANDS_DIR))("runStatus (2026 Dutch GP recording, 11353)", () => {
  it("marks drivers 3, 18, 23, 31, 77 and 87 dnf at the final folded state", () => {
    const state = foldRecording(NETHERLANDS_DIR);
    expect(dnfDriverNumbers(state)).toEqual([3, 18, 23, 31, 77, 87]);
  });
});
