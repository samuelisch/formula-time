import type { RaceEvent, RawRecord } from "@formula-time/domain";
import { leaderLap } from "@formula-time/domain";
import { describe, expect, it } from "vitest";

import { foldAt, foldRace } from "./foldRace.ts";

const SESSION: RawRecord = {
  session_key: 11361,
  name: "Race",
  country: "Italy",
  circuit_key: 39,
  date_start: "2026-09-06T13:00:00.000Z",
  date_end: "2026-09-06T15:00:00.000Z",
  total_laps: 3,
  status: "finished",
};

function isoAt(offsetSeconds: number): string {
  return new Date(Date.parse("2026-09-06T13:00:00.000Z") + offsetSeconds * 1000).toISOString();
}

function event(id: string, endpoint: string, offsetSeconds: number, payload: RawRecord): RaceEvent {
  return { event_id: id, endpoint, source_time: isoAt(offsetSeconds), payload };
}

/** Ten events: two drivers, positions, and three leader laps spaced 20s apart
 * (past `KEYFRAME_SOURCE_TIME_MS` = 30s) so a default fold takes several
 * time-based keyframes as well as lap markers to assert against. */
function tenEventFixture(): RaceEvent[] {
  return [
    event("e1", "position", 0, { driver_number: 1, position: 1 }),
    event("e2", "position", 0, { driver_number: 2, position: 2 }),
    event("e3", "laps", 0, { driver_number: 1, lap_number: 1 }),
    event("e4", "laps", 1, { driver_number: 2, lap_number: 1 }),
    event("e5", "laps", 20, { driver_number: 1, lap_number: 2 }),
    event("e6", "laps", 21, { driver_number: 2, lap_number: 2 }),
    event("e7", "laps", 45, { driver_number: 1, lap_number: 3 }),
    event("e8", "laps", 46, { driver_number: 2, lap_number: 3 }),
    event("e9", "intervals", 46, { driver_number: 2, interval: 1.2, gap_to_leader: 1.2 }),
    event("e10", "race_control", 70, { category: "SessionStatus", message: "FINISHED" }),
  ];
}

describe("foldRace", () => {
  it("is pure: folding the same events twice yields the same final state", async () => {
    const first = await foldRace(tenEventFixture(), SESSION);
    const second = await foldRace(tenEventFixture(), SESSION);
    expect(first.finalState).toEqual(second.finalState);
  });

  it("applies every event into the final state", async () => {
    const folded = await foldRace(tenEventFixture(), SESSION);
    expect(folded.finalState.sequence).toBe(10);
    expect(leaderLap(folded.finalState)).toBe(3);
    expect(folded.finalState.race_control.session_status).toBe("FINISHED");
  });

  it("takes more than one keyframe when events span past KEYFRAME_SOURCE_TIME_MS", async () => {
    const folded = await foldRace(tenEventFixture(), SESSION);
    expect(folded.keyframes.length).toBeGreaterThan(1);
    // The initial keyframe (before any event) always has a null source time.
    expect(folded.keyframes[0]?.sourceMs).toBeNull();
    for (let i = 1; i < folded.keyframes.length; i += 1) {
      expect(folded.keyframes[i]!.sourceMs).toBeGreaterThanOrEqual(folded.keyframes[i - 1]!.sourceMs ?? 0);
    }
  });

  it("records a lap marker at the first source time the leader reaches each lap", async () => {
    const folded = await foldRace(tenEventFixture(), SESSION);
    expect(folded.lapMarkers).toEqual([
      { lap: 1, sourceMs: Date.parse(isoAt(0)) },
      { lap: 2, sourceMs: Date.parse(isoAt(20)) },
      { lap: 3, sourceMs: Date.parse(isoAt(45)) },
    ]);
  });

  it("reports the first and last source times seen", async () => {
    const folded = await foldRace(tenEventFixture(), SESSION);
    expect(folded.firstSourceMs).toBe(Date.parse(isoAt(0)));
    expect(folded.lastSourceMs).toBe(Date.parse(isoAt(70)));
  });

  it("scrub (foldAt) at any source time equals a full fold truncated to events up to that time", async () => {
    const events = tenEventFixture();
    const folded = await foldRace(events, SESSION);

    // Truncate at the lap-2 marker (offset 20s): events e1-e5 have already
    // landed, e6 (offset 21s) has not.
    const targetMs = Date.parse(isoAt(20));
    const truncated = await foldRace(events.filter((e) => Date.parse(e.source_time!) <= targetMs), SESSION);

    const scrubbed = foldAt(folded, targetMs);
    expect(scrubbed).toEqual(truncated.finalState);
  });

  it("scrub before the first event returns the initial (pre-event) state", async () => {
    const folded = await foldRace(tenEventFixture(), SESSION);
    const scrubbed = foldAt(folded, Date.parse(isoAt(0)) - 1);
    expect(scrubbed.sequence).toBe(0);
    expect(leaderLap(scrubbed)).toBe(0);
  });
});
