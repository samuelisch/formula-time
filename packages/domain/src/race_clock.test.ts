import { describe, expect, it } from "vitest";
import { createInitialState, RaceStateReducer } from "./race_state.js";
import type { RaceEvent, RawRecord } from "./types.js";
import { isChequered, leaderLap, locksAtLap } from "./race_clock.js";

function event(eventId: string, endpoint: string, sourceTime: string, payload: RawRecord): RaceEvent {
  return {
    event_id: eventId,
    endpoint,
    source_time: sourceTime,
    payload,
  };
}

function twoDriverState() {
  return createInitialState({
    sessions: [],
    drivers: [
      { driver_number: 1, full_name: "Test Driver", name_acronym: "TST" },
      { driver_number: 2, full_name: "Second Driver", name_acronym: "SEC" },
    ],
  });
}

describe("locksAtLap (PRD §4)", () => {
  it("race-result: halfway, floor(totalLaps / 2)", () => {
    expect(locksAtLap("race-result", { totalLaps: 72 })).toBe(36);
  });

  it("race-result: floor rounding", () => {
    expect(locksAtLap("race-result", { totalLaps: 71 })).toBe(35);
  });

  it("race-result: minimum 1", () => {
    expect(locksAtLap("race-result", { totalLaps: 1 })).toBe(1);
  });

  it("lap-event: eventLap - 2", () => {
    expect(locksAtLap("lap-event", { totalLaps: 72, eventLap: 10 })).toBe(8);
  });

  it("lap-event: minimum 1", () => {
    expect(locksAtLap("lap-event", { totalLaps: 72, eventLap: 2 })).toBe(1);
  });
});

describe("leaderLap (ported from the POC)", () => {
  it("reads the leader's current_lap when driver_order is populated", () => {
    const reducer = new RaceStateReducer(twoDriverState());
    reducer.apply(event("pos-1", "position", "2026-01-01T00:00:01Z", { driver_number: 1, position: 1 }));
    reducer.apply(event("lap-1", "laps", "2026-01-01T00:00:02Z", { driver_number: 1, lap_number: 5 }));
    expect(leaderLap(reducer.snapshot())).toBe(5);
  });

  it("falls back to the furthest lap any driver has reached when driver_order is empty", () => {
    const reducer = new RaceStateReducer(twoDriverState());
    reducer.apply(event("lap-1", "laps", "2026-01-01T00:00:01Z", { driver_number: 1, lap_number: 3 }));
    reducer.apply(event("lap-2", "laps", "2026-01-01T00:00:02Z", { driver_number: 2, lap_number: 7 }));
    expect(leaderLap(reducer.snapshot())).toBe(7);
  });
});

describe("isChequered (ported from the POC)", () => {
  it("is true when current_flag is CHEQUERED", () => {
    const reducer = new RaceStateReducer(twoDriverState());
    reducer.apply(
      event("rc-1", "race_control", "2026-01-01T00:00:01Z", {
        category: "Flag",
        flag: "CHEQUERED",
        scope: "Track",
        message: "CHEQUERED FLAG",
      }),
    );
    expect(isChequered(reducer.snapshot())).toBe(true);
  });

  it("is false otherwise", () => {
    expect(isChequered(twoDriverState())).toBe(false);
  });
});
