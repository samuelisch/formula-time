import type { RaceEvent, RawRecord, RaceState } from "@formula-time/domain";
import { leaderLap } from "@formula-time/domain";
import { describe, expect, it } from "vitest";

import { foldAt, foldRace, truncationBoundary } from "./foldRace.ts";

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

/**
 * The reference for "what a scrub to `targetMs` should show": fold `folded`'s
 * own (already-deduped) events truncated at the same `truncationBoundary`
 * `foldAt` itself uses, so this and `foldAt` can never disagree about where
 * the cut falls (review round 1 fix).
 */
async function foldTruncated(
  folded: Awaited<ReturnType<typeof foldRace>>,
  session: RawRecord,
  targetMs: number,
): Promise<RaceState> {
  const boundary = truncationBoundary(folded.events, targetMs);
  const truncated = await foldRace(folded.events.slice(0, boundary), session);
  return truncated.finalState;
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
    const folded = await foldRace(tenEventFixture(), SESSION);

    // Truncate at the lap-2 marker (offset 20s): events e1-e5 have already
    // landed, e6 (offset 21s) has not.
    const targetMs = Date.parse(isoAt(20));
    const truncatedFinalState = await foldTruncated(folded, SESSION, targetMs);

    const scrubbed = foldAt(folded, targetMs);
    expect(scrubbed).toEqual(truncatedFinalState);
  });

  it("scrub before the first event returns the initial (pre-event) state", async () => {
    const folded = await foldRace(tenEventFixture(), SESSION);
    const scrubbed = foldAt(folded, Date.parse(isoAt(0)) - 1);
    expect(scrubbed.sequence).toBe(0);
    expect(leaderLap(scrubbed)).toBe(0);
  });

  it("dedupes a duplicate event_id straddling a keyframe boundary, so scrub matches a full fold truncated at that point", async () => {
    // e3 (a "pit" event, whose apply() unconditionally pushes to pit_stops --
    // so a wrongly-reapplied duplicate is trivially observable) is duplicated
    // again at offset 45s, after the keyframe e4 (offset 40s) forces (40s
    // past KEYFRAME_SOURCE_TIME_MS's 30s baseline). Without the load-time
    // dedup, a fresh reducer built from that keyframe's snapshot has never
    // "seen" event_id "e3" and would re-apply the duplicate.
    const events: RaceEvent[] = [
      event("e1", "position", 0, { driver_number: 1, position: 1 }),
      event("e2", "laps", 0, { driver_number: 1, lap_number: 1 }),
      event("e3", "pit", 5, { driver_number: 1, pit_duration: 2.4 }),
      event("e4", "laps", 40, { driver_number: 1, lap_number: 2 }), // forces a keyframe after this event
      event("e3", "pit", 45, { driver_number: 1, pit_duration: 2.4 }), // duplicate event_id, past the keyframe
      event("e6", "laps", 80, { driver_number: 1, lap_number: 3 }),
    ];

    const folded = await foldRace(events, SESSION);

    // The duplicate never reaches folded.events at all.
    expect(folded.events.map((e) => e.event_id)).toEqual(["e1", "e2", "e3", "e4", "e6"]);
    expect(folded.finalState.anomalies.duplicate_events).toBe(0);
    expect(folded.finalState.drivers["1"]?.pit_stops).toHaveLength(1);

    // Scrub to a point after the keyframe (40s) but before e6 (80s): the
    // duplicate's own offset (45s) sits inside this window, so a bug would
    // show up as a second pit_stops entry here.
    const targetMs = Date.parse(isoAt(50));
    const truncatedFinalState = await foldTruncated(folded, SESSION, targetMs);
    const scrubbed = foldAt(folded, targetMs);

    expect(scrubbed).toEqual(truncatedFinalState);
    expect(scrubbed.drivers["1"]?.pit_stops).toHaveLength(1);
    expect(leaderLap(scrubbed)).toBe(2);
  });

  it("applies null-source events before the truncation boundary and excludes them after it", async () => {
    // e2 and e4 (null source_time) sit before e5 (offset 50s), the first
    // timestamped event past the target (20s) -- both should apply. e6
    // (null source_time, after e5) should not.
    const events: RaceEvent[] = [
      event("e1", "laps", 0, { driver_number: 1, lap_number: 1 }),
      { event_id: "e2", endpoint: "race_control", source_time: null, payload: { category: "Flag", message: "before-1" } },
      event("e3", "laps", 10, { driver_number: 1, lap_number: 2 }),
      { event_id: "e4", endpoint: "race_control", source_time: null, payload: { category: "Flag", message: "before-2" } },
      event("e5", "laps", 50, { driver_number: 1, lap_number: 3 }), // the truncation boundary for target=20s
      { event_id: "e6", endpoint: "race_control", source_time: null, payload: { category: "Flag", message: "after" } },
    ];

    const folded = await foldRace(events, SESSION);
    const targetMs = Date.parse(isoAt(20));

    expect(truncationBoundary(folded.events, targetMs)).toBe(4); // index of e5

    const truncatedFinalState = await foldTruncated(folded, SESSION, targetMs);
    const scrubbed = foldAt(folded, targetMs);

    expect(scrubbed).toEqual(truncatedFinalState);
    // Both null-source messages before the boundary landed; the one after did not.
    expect(scrubbed.race_control.recent_messages.map((m) => m.payload["message"])).toEqual([
      "before-1",
      "before-2",
    ]);
    expect(leaderLap(scrubbed)).toBe(2);
  });
});
