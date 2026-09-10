import type { DriverState, RaceEvent, RaceState, RawRecord } from "@formula-time/domain";
import { describe, expect, it } from "vitest";

import type { FoldedRace, LapMarker } from "../replay/foldRace.ts";
import { deriveAnchors, deriveTimelineAnchors, emptyAnchors } from "./anchors.ts";
import type { LivePush } from "./types.ts";

function driver(overrides: { currentLap: number | null; lapSourceTime?: string }): DriverState {
  return {
    driver_number: 1,
    full_name: null,
    name_acronym: null,
    team_name: null,
    team_colour: null,
    position: null,
    interval: null,
    gap_to_leader: null,
    current_lap: overrides.currentLap,
    lap_duration: null,
    sector_durations: { sector_1: null, sector_2: null, sector_3: null },
    is_pit_out_lap: null,
    tyre: { stint_number: null, compound: null, lap_start: null, lap_end: null, age_at_start: null, age: null },
    pit_stops: [],
    latest_pit_stop: null,
    source_timestamps: overrides.lapSourceTime === undefined ? {} : { lap: overrides.lapSourceTime },
  };
}

function raceControlMessage(payload: RawRecord): { event_id: string; payload: RawRecord } {
  return { event_id: String(Math.random()), payload };
}

function push(overrides: {
  drivers?: Record<string, DriverState>;
  recentMessages?: Array<{ event_id: string; payload: RawRecord }>;
}): LivePush {
  const state: RaceState = {
    sequence: 1,
    latest_source_time: null,
    session: null,
    drivers: overrides.drivers ?? {},
    driver_order: [],
    race_control: {
      session_status: null,
      current_flag: null,
      safety_car: null,
      active_flags: {},
      driver_flags: {},
      recent_messages: overrides.recentMessages ?? [],
    },
    weather: null,
    anomalies: { duplicate_events: 0, stale_updates: 0, missing_driver: 0, unsupported_events: 0 },
  };
  return { type: "state", seq: "1", sent_at: 0, session_key: "9999", total_laps: 58, state, polls: [] };
}

describe("deriveAnchors", () => {
  it("records the earliest lap-start time seen among drivers reaching that lap", () => {
    const seen = new Set<string>();
    let anchors = emptyAnchors();

    anchors = deriveAnchors(
      anchors,
      push({
        drivers: {
          "1": driver({ currentLap: 1, lapSourceTime: "2026-09-08T12:00:00.000Z" }),
          "2": driver({ currentLap: 1, lapSourceTime: "2026-09-08T12:00:00.500Z" }),
        },
      }),
      seen,
    );

    expect(anchors.laps).toEqual([{ lap: 1, source_time: "2026-09-08T12:00:00.000Z" }]);
  });

  it("keeps the earlier time when a later push reports an earlier one for the same lap", () => {
    const seen = new Set<string>();
    let anchors = emptyAnchors();

    anchors = deriveAnchors(
      anchors,
      push({ drivers: { "1": driver({ currentLap: 2, lapSourceTime: "2026-09-08T12:05:00.000Z" }) } }),
      seen,
    );
    expect(anchors.laps).toEqual([{ lap: 2, source_time: "2026-09-08T12:05:00.000Z" }]);

    // A later push shows a driver reaching lap 2 with an earlier source time
    // (e.g. a straggler's row lands after the leader's) -> the anchor moves earlier.
    anchors = deriveAnchors(
      anchors,
      push({ drivers: { "1": driver({ currentLap: 2, lapSourceTime: "2026-09-08T12:04:58.000Z" }) } }),
      seen,
    );
    expect(anchors.laps).toEqual([{ lap: 2, source_time: "2026-09-08T12:04:58.000Z" }]);

    // A later push showing a *later* time for lap 2 must not move the anchor forward.
    anchors = deriveAnchors(
      anchors,
      push({ drivers: { "1": driver({ currentLap: 2, lapSourceTime: "2026-09-08T12:05:10.000Z" }) } }),
      seen,
    );
    expect(anchors.laps).toEqual([{ lap: 2, source_time: "2026-09-08T12:04:58.000Z" }]);
  });

  it("sets lights_out to the lap-1 anchor and leaves it null until lap 1 is seen", () => {
    const seen = new Set<string>();
    let anchors = emptyAnchors();

    anchors = deriveAnchors(
      anchors,
      push({ drivers: { "1": driver({ currentLap: 3, lapSourceTime: "2026-09-08T12:10:00.000Z" }) } }),
      seen,
    );
    expect(anchors.lights_out).toBeNull();

    anchors = deriveAnchors(
      anchors,
      push({ drivers: { "1": driver({ currentLap: 1, lapSourceTime: "2026-09-08T12:00:00.000Z" }) } }),
      seen,
    );
    expect(anchors.lights_out).toBe("2026-09-08T12:00:00.000Z");
  });

  it("ignores drivers with a null current_lap or no lap source timestamp", () => {
    const seen = new Set<string>();
    const anchors = deriveAnchors(
      emptyAnchors(),
      push({
        drivers: {
          "1": driver({ currentLap: null }),
          "2": driver({ currentLap: 4 }), // no lapSourceTime
        },
      }),
      seen,
    );
    expect(anchors.laps).toEqual([]);
    expect(anchors.lights_out).toBeNull();
  });

  it("collects SESSION STARTED restarts ascending and deduplicated across pushes", () => {
    const seen = new Set<string>();
    let anchors = emptyAnchors();

    anchors = deriveAnchors(
      anchors,
      push({
        recentMessages: [
          raceControlMessage({ category: "SessionStatus", message: "SESSION STARTED", date: "2026-09-08T12:00:00.000Z" }),
          raceControlMessage({ category: "SessionStatus", message: "AFTER RED FLAG", date: "2026-09-08T12:20:00.000Z" }),
        ],
      }),
      seen,
    );
    expect(anchors.restarts).toEqual(["2026-09-08T12:00:00.000Z"]);

    // Next push resends the same rolling window (same first message still in
    // it) plus one new restart out of chronological order in the payload.
    anchors = deriveAnchors(
      anchors,
      push({
        recentMessages: [
          raceControlMessage({ category: "SessionStatus", message: "SESSION STARTED", date: "2026-09-08T12:00:00.000Z" }),
          raceControlMessage({ category: "SessionStatus", message: "SESSION STARTED", date: "2026-09-08T11:59:00.000Z" }),
        ],
      }),
      seen,
    );
    expect(anchors.restarts).toEqual(["2026-09-08T11:59:00.000Z", "2026-09-08T12:00:00.000Z"]);
  });

  it("ignores race-control rows that are not a SESSION STARTED SessionStatus row", () => {
    const seen = new Set<string>();
    const anchors = deriveAnchors(
      emptyAnchors(),
      push({
        recentMessages: [
          raceControlMessage({ category: "Flag", message: "SESSION STARTED", date: "2026-09-08T12:00:00.000Z" }),
          raceControlMessage({ category: "SessionStatus", message: "SESSION ABORTED", date: "2026-09-08T12:05:00.000Z" }),
        ],
      }),
      seen,
    );
    expect(anchors.restarts).toEqual([]);
  });
});

function raceControlEvent(id: string, message: string, date: string): RaceEvent {
  return {
    event_id: id,
    endpoint: "race_control",
    source_time: date,
    payload: { category: "SessionStatus", message, date },
  };
}

function folded(overrides: Partial<FoldedRace> = {}): FoldedRace {
  const lapMarkers: LapMarker[] = overrides.lapMarkers ?? [
    { lap: 1, sourceMs: Date.parse("2026-09-06T13:00:00.000Z") },
    { lap: 2, sourceMs: Date.parse("2026-09-06T13:01:30.000Z") },
  ];
  return {
    session: {},
    events: [],
    keyframes: [],
    lapStartsMs: {},
    finalState: {} as never,
    firstSourceMs: Date.parse("2026-09-06T13:00:00.000Z"),
    lastSourceMs: Date.parse("2026-09-06T13:01:30.000Z"),
    lapMarkers,
    ...overrides,
  };
}

// deriveTimelineAnchors takes a `Timeline` (a `FoldedRace` satisfies that
// shape unchanged) rather than only a `FoldedRace`, so the replay fold and
// the live timeline share one anchor derivation.
describe("deriveTimelineAnchors", () => {
  it("lap N's anchor is the lap marker's source time, and lights_out is lap 1's", () => {
    const anchors = deriveTimelineAnchors(folded());
    expect(anchors.lights_out).toBe("2026-09-06T13:00:00.000Z");
    expect(anchors.laps).toEqual([
      { lap: 1, source_time: "2026-09-06T13:00:00.000Z" },
      { lap: 2, source_time: "2026-09-06T13:01:30.000Z" },
    ]);
  });

  it("lights_out is null when lap 1 was never reached", () => {
    const anchors = deriveTimelineAnchors(folded({ lapMarkers: [{ lap: 2, sourceMs: 1_000 }] }));
    expect(anchors.lights_out).toBeNull();
  });

  it("restarts are SESSION STARTED race-control events, deduped and sorted", () => {
    const events: RaceEvent[] = [
      raceControlEvent("e1", "SESSION STARTED", "2026-09-06T13:05:00.000Z"),
      raceControlEvent("e2", "SESSION STARTED", "2026-09-06T13:00:00.000Z"), // earlier, out of order
      raceControlEvent("e3", "SESSION STARTED", "2026-09-06T13:00:00.000Z"), // duplicate date
      raceControlEvent("e4", "SAFETY CAR DEPLOYED", "2026-09-06T13:02:00.000Z"), // not a restart
      { event_id: "e5", endpoint: "laps", source_time: "2026-09-06T13:03:00.000Z", payload: { category: "SessionStatus", message: "SESSION STARTED", date: "2026-09-06T13:03:00.000Z" } }, // wrong endpoint
    ];
    const anchors = deriveTimelineAnchors(folded({ events }));
    expect(anchors.restarts).toEqual(["2026-09-06T13:00:00.000Z", "2026-09-06T13:05:00.000Z"]);
  });
});
