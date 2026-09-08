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

// Drivers are events (HLD §7): a `drivers` row must fold into state.drivers,
// not be treated as an unknown endpoint.
describe("RaceStateReducer (drivers as events)", () => {
  it("adds an unknown driver from a drivers event", () => {
    const reducer = new RaceStateReducer(createInitialState({ sessions: [], drivers: [] }));

    reducer.apply(
      event("driver-3", "drivers", "2026-01-01T00:00:00Z", {
        driver_number: 3,
        full_name: "Third Driver",
        name_acronym: "THI",
        team_name: "Third Team",
        team_colour: "00FF00",
      }),
    );

    const state = reducer.snapshot();
    expect(state.drivers["3"]).toMatchObject({
      driver_number: 3,
      full_name: "Third Driver",
      name_acronym: "THI",
      team_name: "Third Team",
      team_colour: "00FF00",
    });
    expect(state.anomalies.unsupported_events).toBe(0);
  });

  it("keeps a known driver's timing state and updates its identity fields on a drivers event", () => {
    const reducer = new RaceStateReducer(twoDriverState());

    reducer.apply(
      event("position-1", "position", "2026-01-01T00:00:01Z", {
        driver_number: 1,
        position: 4,
      }),
    );
    reducer.apply(
      event("driver-1-swap", "drivers", "2026-01-01T00:00:02Z", {
        driver_number: 1,
        full_name: "Replacement Driver",
        name_acronym: "REP",
        team_name: "Test Team",
        team_colour: "FF0000",
      }),
    );

    const state = reducer.snapshot();
    expect(state.drivers["1"]?.position).toBe(4);
    expect(state.drivers["1"]?.full_name).toBe("Replacement Driver");
    expect(state.drivers["1"]?.name_acronym).toBe("REP");
    expect(state.drivers["1"]?.team_colour).toBe("FF0000");
    expect(state.anomalies.unsupported_events).toBe(0);
  });

  it("produces the same state.drivers whether the entry list is passed up front or as drivers events", () => {
    const upFront = createInitialState({
      sessions: [],
      drivers: [
        { driver_number: 1, full_name: "Test Driver", name_acronym: "TST", team_name: "Test Team" },
        { driver_number: 2, full_name: "Second Driver", name_acronym: "SEC", team_name: "Test Team" },
      ],
    });

    const viaEvents = new RaceStateReducer(createInitialState({ sessions: [], drivers: [] }));
    viaEvents.apply(
      event("driver-1", "drivers", "2026-01-01T00:00:00Z", {
        driver_number: 1,
        full_name: "Test Driver",
        name_acronym: "TST",
        team_name: "Test Team",
      }),
    );
    viaEvents.apply(
      event("driver-2", "drivers", "2026-01-01T00:00:01Z", {
        driver_number: 2,
        full_name: "Second Driver",
        name_acronym: "SEC",
        team_name: "Test Team",
      }),
    );

    expect(viaEvents.snapshot().drivers).toEqual(upFront.drivers);
  });

  it("counts an unknown endpoint as unsupported and changes nothing else", () => {
    const reducer = new RaceStateReducer(twoDriverState());

    reducer.apply(
      event("mystery-1", "tyre_pressure", "2026-01-01T00:00:00Z", {
        driver_number: 1,
        pressure: 22,
      }),
    );

    const state = reducer.snapshot();
    expect(state.anomalies.unsupported_events).toBe(1);
    expect(state.drivers["1"]?.position).toBeNull();
    expect(state.driver_order).toEqual([]);
  });
});
