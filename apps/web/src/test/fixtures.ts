// Shared test fixtures for board components (issue #48) and later slices
// that render the same push shape (polls, alignment, replay).
import type { DriverState, RaceState } from "@formula-time/domain";

import type { LivePush } from "../live/types.ts";

/** A driver with every field defaulted to its "no data yet" value; pass only what a test cares about. */
export function makeDriver(overrides: Partial<DriverState> & { driver_number: number }): DriverState {
  return {
    driver_number: overrides.driver_number,
    full_name: overrides.full_name ?? null,
    name_acronym: overrides.name_acronym ?? null,
    team_name: overrides.team_name ?? null,
    team_colour: overrides.team_colour ?? null,
    position: overrides.position ?? null,
    interval: overrides.interval ?? null,
    gap_to_leader: overrides.gap_to_leader ?? null,
    current_lap: overrides.current_lap ?? null,
    lap_duration: overrides.lap_duration ?? null,
    sector_durations: overrides.sector_durations ?? { sector_1: null, sector_2: null, sector_3: null },
    is_pit_out_lap: overrides.is_pit_out_lap ?? null,
    tyre: overrides.tyre ?? { stint_number: null, compound: null, lap_start: null, lap_end: null, age_at_start: null, age: null },
    pit_stops: overrides.pit_stops ?? [],
    latest_pit_stop: overrides.latest_pit_stop ?? null,
    source_timestamps: overrides.source_timestamps ?? {},
  };
}

/**
 * A two-driver RaceState with realistic values (positions, gaps, tyres, a
 * pit stop) so component tests have real formatting to assert against.
 * Pass `overrides` to replace any top-level field, e.g. an empty `drivers`
 * map for the empty-state case or a custom `race_control` for a flag combo.
 */
export function makeState(overrides: Partial<RaceState> = {}): RaceState {
  const verstappen = makeDriver({
    driver_number: 1,
    full_name: "Max Verstappen",
    name_acronym: "VER",
    team_name: "Red Bull Racing",
    team_colour: "3671C6",
    position: 1,
    current_lap: 12,
    tyre: { stint_number: 2, compound: "MEDIUM", lap_start: 8, lap_end: null, age_at_start: 0, age: 4 },
    latest_pit_stop: { lap_number: 7, pit_duration: 2.4 },
  });
  const hamilton = makeDriver({
    driver_number: 44,
    full_name: "Lewis Hamilton",
    name_acronym: "HAM",
    team_name: "Mercedes",
    team_colour: "27F4D2",
    position: 2,
    interval: 1.234,
    gap_to_leader: 1.234,
    current_lap: 12,
    tyre: { stint_number: 2, compound: "HARD", lap_start: 8, lap_end: null, age_at_start: 0, age: 4 },
  });

  return {
    sequence: 1,
    latest_source_time: "2026-09-08T13:00:00.000Z",
    session: {
      session_key: "9999",
      name: "Race",
      country: "Italy",
      circuit_key: 39,
      date_start: "2026-09-08T12:00:00.000Z",
      date_end: "2026-09-08T15:00:00.000Z",
      total_laps: 53,
      status: "Started",
    },
    drivers: { "1": verstappen, "44": hamilton },
    driver_order: [1, 44],
    race_control: {
      session_status: "SESSION STARTED",
      current_flag: null,
      safety_car: null,
      active_flags: {},
      driver_flags: {},
      recent_messages: [],
    },
    weather: { air_temperature: 24.5, track_temperature: 31.2, humidity: 55, rainfall: 0 },
    anomalies: { duplicate_events: 0, stale_updates: 0, missing_driver: 0, unsupported_events: 0 },
    ...overrides,
  };
}

/** Wraps `makeState()` in the wire-shaped `LivePush` that board components read via `BoardSourceProvider`. */
export function makePush(overrides: Partial<LivePush> = {}, stateOverrides: Partial<RaceState> = {}): LivePush {
  return {
    type: "state",
    seq: "1",
    sent_at: Date.now(),
    session_key: "9999",
    total_laps: 53,
    state: makeState(stateOverrides),
    polls: [],
    ...overrides,
  };
}
