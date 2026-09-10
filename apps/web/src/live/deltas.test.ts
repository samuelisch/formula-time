import { createInitialState, diffState, RaceStateReducer, type RaceState } from "@formula-time/domain";
import { describe, expect, it } from "vitest";

import { makePush } from "../test/fixtures.ts";
import { applyDelta } from "./deltas.ts";
import type { DeltaPush, LivePush } from "./types.ts";

/** Two reducer-built states from the same lineage, sharing the fixture the server-side patch test uses (createInitialState/RaceStateReducer, diffState) so the patch this test applies is the same shape the server actually sends. */
function fixtureStates(): { prev: RaceState; next: RaceState } {
  const reducer = new RaceStateReducer(
    createInitialState({
      sessions: [{ session_key: 9999, status: "live" }],
      drivers: [{ driver_number: 1, full_name: "Driver One" }],
    }),
  );
  const prev = reducer.snapshot();
  reducer.apply({
    event_id: "e1",
    endpoint: "position",
    source_time: "2026-09-06T13:00:00Z",
    payload: { driver_number: 1, position: 1 },
  });
  const next = reducer.snapshot();
  return { prev, next };
}

function deltaFrame(overrides: Partial<DeltaPush> & { base_seq: string }): DeltaPush {
  const { prev, next } = fixtureStates();
  return {
    type: "delta",
    seq: "2",
    sent_at: 2_000,
    session_key: "9999",
    patch: diffState(prev, next),
    polls: [],
    ...overrides,
  };
}

function heldWithState(state: RaceState, overrides: Partial<LivePush> = {}): LivePush {
  return makePush({ seq: "1", state, ...overrides });
}

describe("applyDelta", () => {
  it("round-trips a patch built with diffState against a held push, producing the patched state", () => {
    const { prev, next } = fixtureStates();
    const held = heldWithState(prev, { sent_at: 1_000 });

    const frame = deltaFrame({ base_seq: held.seq, patch: diffState(prev, next) });
    const result = applyDelta(held, frame);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("state");
    expect(result!.seq).toBe(frame.seq);
    expect(result!.sent_at).toBe(frame.sent_at);
    expect(result!.session_key).toBe(frame.session_key);
    expect(result!.state).toEqual(next);
  });

  it("carries total_laps through from the held push, not the frame", () => {
    const { prev } = fixtureStates();
    const held = heldWithState(prev, { total_laps: 53 });

    const result = applyDelta(held, deltaFrame({ base_seq: "1" }));

    expect(result!.total_laps).toBe(53);
  });

  it("carries polls, events and rebuilt through from the frame", () => {
    const { prev } = fixtureStates();
    const held = heldWithState(prev);

    const event = { event_id: "e1", endpoint: "position", source_time: null, payload: {} };
    const result = applyDelta(held, deltaFrame({ base_seq: "1", events: [event], rebuilt: true }));

    expect(result!.events).toEqual([event]);
    expect(result!.rebuilt).toBe(true);
  });

  it("leaves events and rebuilt undefined when the frame does not carry them", () => {
    const { prev } = fixtureStates();
    const held = heldWithState(prev);

    const result = applyDelta(held, deltaFrame({ base_seq: "1" }));

    expect(result!.events).toBeUndefined();
    expect(result!.rebuilt).toBeUndefined();
  });

  it("returns null when the frame's base_seq does not match the held push's seq -- a gap", () => {
    const { prev } = fixtureStates();
    const held = heldWithState(prev, { seq: "5" });

    expect(applyDelta(held, deltaFrame({ base_seq: "4" }))).toBeNull();
  });

  it("returns null when nothing is held yet", () => {
    expect(applyDelta(null, deltaFrame({ base_seq: "1" }))).toBeNull();
  });

  it("never mutates the held push's state", () => {
    const { prev, next } = fixtureStates();
    const held = heldWithState(prev);
    const heldStateBefore = structuredClone(held.state);

    applyDelta(held, deltaFrame({ base_seq: "1", patch: diffState(prev, next) }));

    expect(held.state).toEqual(heldStateBefore);
  });
});
