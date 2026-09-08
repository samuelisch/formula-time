import { describe, expect, it } from "vitest";
import { createInitialState, RaceStateReducer } from "./race_state.js";
import type { RaceEvent, RawRecord } from "./types.js";

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
      {
        driver_number: 1,
        full_name: "Test Driver",
        name_acronym: "TST",
        team_name: "Test Team",
      },
      {
        driver_number: 2,
        full_name: "Second Driver",
        name_acronym: "SEC",
        team_name: "Test Team",
      },
    ],
  });
}

// Ported from the POC's check_reducer.ts checkReducerRules().
describe("RaceStateReducer (ported POC rules)", () => {
  it("ignores a stale position but counts it, counts a duplicate event once, materialises driver_order", () => {
    const reducer = new RaceStateReducer(twoDriverState());

    reducer.apply(
      event("position-new", "position", "2026-01-01T00:00:02Z", {
        driver_number: 1,
        position: 2,
      }),
    );
    reducer.apply(
      event("position-old", "position", "2026-01-01T00:00:01Z", {
        driver_number: 1,
        position: 5,
      }),
    );
    reducer.apply(
      event("position-new", "position", "2026-01-01T00:00:02Z", {
        driver_number: 1,
        position: 2,
      }),
    );
    reducer.apply(
      event("position-second", "position", "2026-01-01T00:00:03Z", {
        driver_number: 2,
        position: 1,
      }),
    );

    const state = reducer.snapshot();
    expect(state.drivers["1"]?.position).toBe(2);
    expect(state.anomalies.stale_updates).toBe(1);
    expect(state.anomalies.duplicate_events).toBe(1);
    expect(state.driver_order).toEqual([2, 1]);
  });

  it("transitions safety_car VSC -> SC -> null on race_control messages", () => {
    const reducer = new RaceStateReducer(twoDriverState());

    reducer.apply(
      event("vsc-deployed", "race_control", "2026-01-01T00:00:04Z", {
        category: "SafetyCar",
        message: "VSC DEPLOYED",
      }),
    );
    expect(reducer.snapshot().race_control.safety_car).toBe("VSC");

    reducer.apply(
      event("sc-deployed", "race_control", "2026-01-01T00:00:05Z", {
        category: "SafetyCar",
        message: "SAFETY CAR DEPLOYED",
      }),
    );
    expect(reducer.snapshot().race_control.safety_car).toBe("SC");

    reducer.apply(
      event("sc-ending", "race_control", "2026-01-01T00:00:06Z", {
        category: "SafetyCar",
        message: "SAFETY CAR IN THIS LAP",
      }),
    );
    expect(reducer.snapshot().race_control.safety_car).toBeNull();
  });
});
