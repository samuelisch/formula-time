import { describe, expect, it } from "vitest";

import { applyPatch, diffState } from "./patch.js";
import { createInitialState, RaceStateReducer } from "./race_state.js";

// The full diffState/applyPatch round-trip suite lives in
// apps/api/src/fanout/patch.test.ts, importing this module's re-export
// from @formula-time/domain -- it stays put and unmodified by this move.
// This file only pins the purity contract this package's browser client
// relies on: applyPatch must never mutate the state it is handed.
describe("applyPatch purity", () => {
  it("never mutates its input state, at any nesting depth touched by the patch", () => {
    const reducer = new RaceStateReducer(
      createInitialState({
        sessions: [{ session_key: 1, status: "live" }],
        drivers: [{ driver_number: 1, full_name: "Driver One" }],
      }),
    );
    const prev = reducer.snapshot();
    const prevSnapshotBefore = structuredClone(prev);

    reducer.apply({
      event_id: "e1",
      endpoint: "position",
      source_time: "2026-09-06T13:00:00Z",
      payload: { driver_number: 1, position: 1 },
    });
    const next = reducer.snapshot();

    const ops = diffState(prev, next);
    expect(ops.length).toBeGreaterThan(0);

    const applied = applyPatch(prev, ops);

    expect(prev).toEqual(prevSnapshotBefore); // untouched by the call
    expect(applied).toEqual(next); // still round-trips correctly
    expect(applied).not.toBe(prev); // a genuinely new object, not the input back
  });
});
