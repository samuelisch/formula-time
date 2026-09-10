import { describe, expect, it } from "vitest";

import { createInitialState, RaceStateReducer, type RaceState, type RawRecord } from "@formula-time/domain";

import { applyPatch, diffState } from "./patch.js";

function event(eventId: string, endpoint: string, sourceTime: string, payload: RawRecord) {
  return { event_id: eventId, endpoint, source_time: sourceTime, payload };
}

function fixtureState(): RaceState {
  const reducer = new RaceStateReducer(
    createInitialState({
      sessions: [
        {
          session_key: 11361,
          name: "Italian GP",
          country: "Italy",
          circuit_key: 39,
          date_start: "2026-09-06T13:00:00Z",
          date_end: "2026-09-06T15:00:00Z",
          total_laps: 53,
          status: "live",
        },
      ],
      drivers: [
        { driver_number: 1, full_name: "Driver One", name_acronym: "ONE", team_name: "Team A", team_colour: "F47600" },
        { driver_number: 2, full_name: "Driver Two", name_acronym: "TWO", team_name: "Team B", team_colour: "4781D7" },
        { driver_number: 3, full_name: "Driver Three", name_acronym: "THR", team_name: "Team A", team_colour: "F47600" },
      ],
    }),
  );

  reducer.apply(event("p1", "position", "2026-09-06T13:00:01Z", { driver_number: 1, position: 1 }));
  reducer.apply(event("p2", "position", "2026-09-06T13:00:01Z", { driver_number: 2, position: 2 }));
  reducer.apply(event("p3", "position", "2026-09-06T13:00:01Z", { driver_number: 3, position: 3 }));
  reducer.apply(event("i1", "intervals", "2026-09-06T13:00:02Z", { driver_number: 2, interval: 1.2, gap_to_leader: 1.2 }));
  reducer.apply(
    event("l1", "laps", "2026-09-06T13:00:03Z", {
      driver_number: 1,
      lap_number: 10,
      lap_duration: 91.234,
      duration_sector_1: 30.1,
      duration_sector_2: 30.2,
      duration_sector_3: 30.9,
      is_pit_out_lap: false,
    }),
  );
  reducer.apply(
    event("rc1", "race_control", "2026-09-06T13:00:04Z", { category: "SafetyCar", message: "VSC DEPLOYED" }),
  );
  reducer.apply(event("w1", "weather", "2026-09-06T13:00:05Z", { date: "2026-09-06T13:00:05Z", air_temperature: 28.4 }));

  return reducer.snapshot();
}

const ENDPOINTS = ["position", "intervals", "laps", "stints", "pit", "race_control", "weather"] as const;

function randomMutation(reducer: RaceStateReducer, seq: number): void {
  const endpoint = ENDPOINTS[seq % ENDPOINTS.length] as (typeof ENDPOINTS)[number];
  const driverNumber = (seq % 3) + 1;
  const sourceTime = new Date(Date.parse("2026-09-06T13:00:10Z") + seq * 1000).toISOString();

  switch (endpoint) {
    case "position":
      reducer.apply(
        event(`mut-${seq}`, "position", sourceTime, { driver_number: driverNumber, position: (seq % 3) + 1 }),
      );
      break;
    case "intervals":
      reducer.apply(
        event(`mut-${seq}`, "intervals", sourceTime, {
          driver_number: driverNumber,
          interval: seq * 0.1,
          gap_to_leader: seq * 0.2,
        }),
      );
      break;
    case "laps":
      reducer.apply(
        event(`mut-${seq}`, "laps", sourceTime, {
          driver_number: driverNumber,
          lap_number: seq,
          lap_duration: 90 + (seq % 5),
          duration_sector_1: 30,
          duration_sector_2: 30,
          duration_sector_3: 30,
          is_pit_out_lap: seq % 7 === 0,
        }),
      );
      break;
    case "stints":
      reducer.apply(
        event(`mut-${seq}`, "stints", sourceTime, {
          driver_number: driverNumber,
          stint_number: (seq % 4) + 1,
          compound: seq % 2 === 0 ? "SOFT" : "MEDIUM",
          lap_start: seq,
          tyre_age_at_start: seq % 10,
        }),
      );
      break;
    case "pit":
      reducer.apply(
        event(`mut-${seq}`, "pit", sourceTime, { driver_number: driverNumber, lap_number: seq, pit_duration: 2.3 }),
      );
      break;
    case "race_control":
      reducer.apply(
        event(`mut-${seq}`, "race_control", sourceTime, {
          category: "Flag",
          flag: seq % 2 === 0 ? "YELLOW" : "CLEAR",
          scope: "Sector",
          sector: (seq % 3) + 1,
        }),
      );
      break;
    case "weather":
      reducer.apply(
        event(`mut-${seq}`, "weather", sourceTime, { date: sourceTime, air_temperature: 20 + (seq % 15) }),
      );
      break;
  }
}

describe("diffState / applyPatch", () => {
  it("yields no ops for an unchanged state", () => {
    const state = fixtureState();
    expect(diffState(state, state)).toEqual([]);
  });

  it("round-trips 500 random mutations: applyPatch(prev, diffState(prev, next)) deep-equals next", () => {
    const reducer = new RaceStateReducer(fixtureState());
    let prev = reducer.snapshot();

    for (let seq = 0; seq < 500; seq += 1) {
      randomMutation(reducer, seq);
      const next = reducer.snapshot();
      const ops = diffState(prev, next);
      const applied = applyPatch(prev, ops);
      expect(applied).toEqual(next);
      prev = next;
    }
  });

  it("only touches the changed driver's fields, not every driver", () => {
    const prev = fixtureState();
    const reducer = new RaceStateReducer(structuredClone(prev));
    reducer.apply(event("touch-2", "intervals", "2026-09-06T13:00:20Z", { driver_number: 2, interval: 5, gap_to_leader: 5 }));
    const next = reducer.snapshot();

    const ops = diffState(prev, next);
    const driverPaths = ops.filter((op) => op.path.startsWith("/drivers/"));
    expect(driverPaths.every((op) => op.path.startsWith("/drivers/2/"))).toBe(true);
    expect(driverPaths.length).toBeGreaterThan(0);
  });

  it("round-trips a driver's gap_to_leader through a lapped string and back to a number", () => {
    const prev = fixtureState();
    const reducer = new RaceStateReducer(structuredClone(prev));

    reducer.apply(
      event("lap-3", "intervals", "2026-09-06T13:00:20Z", { driver_number: 3, interval: 1.5, gap_to_leader: "+1 LAP" }),
    );
    const lapped = reducer.snapshot();
    const lappedOps = diffState(prev, lapped);
    expect(lapped.drivers["3"]?.gap_to_leader).toBe("+1 LAP");
    expect(applyPatch(prev, lappedOps)).toEqual(lapped);

    reducer.apply(
      event("lap-3-back", "intervals", "2026-09-06T13:00:21Z", { driver_number: 3, interval: 1.6, gap_to_leader: 22.1 }),
    );
    const unlapped = reducer.snapshot();
    const unlappedOps = diffState(lapped, unlapped);
    expect(unlapped.drivers["3"]?.gap_to_leader).toBe(22.1);
    expect(applyPatch(lapped, unlappedOps)).toEqual(unlapped);
  });

  it("adds a whole driver object when a new driver key appears", () => {
    const prev = fixtureState();
    const reducer = new RaceStateReducer(structuredClone(prev));
    reducer.apply(event("new-driver", "position", "2026-09-06T13:00:30Z", { driver_number: 99, position: 4 }));
    const next = reducer.snapshot();

    const ops = diffState(prev, next);
    const addOp = ops.find((op) => op.path === "/drivers/99");
    expect(addOp).toBeDefined();
    expect(addOp?.op).toBe("add");
    expect(applyPatch(prev, ops)).toEqual(next);
  });
});
