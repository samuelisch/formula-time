// Issue #97 PR1: timeline.ts is the incremental fold extracted out of
// foldRace.ts (which is now a thin wrapper: `createTimeline` +
// `appendEvents` in one call, see foldRace.test.ts for the fold's own
// behaviour -- keyframe cadence, dedupe, null-source truncation). These
// tests exercise the same fixtures the way the live path will actually
// call this module: `appendEvents` called more than once, as pages arrive,
// and assert the result is identical to a single-shot `foldRace` over the
// same events -- keyframes, lap markers, source-time bounds, and `foldAt`
// at several points, including a duplicate `event_id` and null-source
// events straddling a page boundary.
import type { RaceEvent, RawRecord } from "@formula-time/domain";
import { leaderLap } from "@formula-time/domain";
import { describe, expect, it } from "vitest";

import { foldRace } from "./foldRace.ts";
import { appendEvents, createTimeline, foldAt, lapMarkers, truncationBoundary, type Timeline } from "./timeline.ts";

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
 * (past `KEYFRAME_SOURCE_TIME_MS` = 30s), same fixture as foldRace.test.ts's
 * `tenEventFixture`. */
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

/** Splits `events` into `pageSize`-sized pages, preserving order. */
function paged(events: RaceEvent[], pageSize: number): RaceEvent[][] {
  const pages: RaceEvent[][] = [];
  for (let index = 0; index < events.length; index += pageSize) {
    pages.push(events.slice(index, index + pageSize));
  }
  return pages;
}

/** Builds a `Timeline` by calling `appendEvents` once per page, as the live path does. */
async function buildPaged(events: RaceEvent[], pageSize: number, session: RawRecord = SESSION): Promise<Timeline> {
  const timeline = createTimeline(session);
  for (const page of paged(events, pageSize)) {
    await appendEvents(timeline, page);
  }
  return timeline;
}

describe("timeline.ts appendEvents", () => {
  it("appending across several pages yields the same events, keyframes, and lap markers as a single-shot fold", async () => {
    const events = tenEventFixture();
    const singleShot = await foldRace(events, SESSION);
    const pagedTimeline = await buildPaged(events, 3);

    expect(pagedTimeline.events.map((e) => e.event_id)).toEqual(singleShot.events.map((e) => e.event_id));
    expect(pagedTimeline.keyframes).toEqual(singleShot.keyframes);
    expect(pagedTimeline.lapMarkers).toEqual(singleShot.lapMarkers);
    expect(pagedTimeline.firstSourceMs).toBe(singleShot.firstSourceMs);
    expect(pagedTimeline.lastSourceMs).toBe(singleShot.lastSourceMs);
  });

  it("keeps a keyframe every KEYFRAME_EVENT_INTERVAL/KEYFRAME_SOURCE_TIME_MS boundary across pages, same as foldRace", async () => {
    const events = tenEventFixture();
    const pagedTimeline = await buildPaged(events, 1); // one event per page: the worst case for continuation state
    const singleShot = await foldRace(events, SESSION);

    expect(pagedTimeline.keyframes.length).toBeGreaterThan(1);
    expect(pagedTimeline.keyframes).toEqual(singleShot.keyframes);
  });

  it("lapMarkers(timeline) returns the markers recorded so far", async () => {
    const timeline = await buildPaged(tenEventFixture(), 4);
    expect(lapMarkers(timeline)).toEqual([
      { lap: 1, sourceMs: Date.parse(isoAt(0)) },
      { lap: 2, sourceMs: Date.parse(isoAt(20)) },
      { lap: 3, sourceMs: Date.parse(isoAt(45)) },
    ]);
  });

  it("foldAt on a paged timeline equals a fresh full fold truncated to the same boundary, at several points", async () => {
    const events = tenEventFixture();
    const pagedTimeline = await buildPaged(events, 3);

    for (const targetMs of [Date.parse(isoAt(0)) - 1, Date.parse(isoAt(20)), Date.parse(isoAt(46)), Date.parse(isoAt(70))]) {
      const boundary = truncationBoundary(pagedTimeline.events, targetMs);
      const truncated = await foldRace(pagedTimeline.events.slice(0, boundary), SESSION);
      expect(foldAt(pagedTimeline, targetMs)).toEqual(truncated.finalState);
    }
  });

  it("dedupes a duplicate event_id spanning a page boundary, matching a single-shot fold", async () => {
    // e3 duplicated again after e4 forces a keyframe (40s, past the 30s
    // KEYFRAME_SOURCE_TIME_MS baseline) -- same shape as foldRace.test.ts's
    // dedupe regression fixture, but split across two `appendEvents` pages
    // right at the duplicate.
    const events: RaceEvent[] = [
      event("e1", "position", 0, { driver_number: 1, position: 1 }),
      event("e2", "laps", 0, { driver_number: 1, lap_number: 1 }),
      event("e3", "pit", 5, { driver_number: 1, pit_duration: 2.4 }),
      event("e4", "laps", 40, { driver_number: 1, lap_number: 2 }), // forces a keyframe after this event
      event("e3", "pit", 45, { driver_number: 1, pit_duration: 2.4 }), // duplicate event_id, past the keyframe
      event("e6", "laps", 80, { driver_number: 1, lap_number: 3 }),
    ];

    const timeline = createTimeline(SESSION);
    await appendEvents(timeline, events.slice(0, 4)); // page 1: up to and including e4 (forces the keyframe)
    await appendEvents(timeline, events.slice(4)); // page 2: the duplicate e3, then e6

    expect(timeline.events.map((e) => e.event_id)).toEqual(["e1", "e2", "e3", "e4", "e6"]);
    expect(timeline.lapMarkers.map((m) => m.lap)).toEqual([1, 2, 3]);

    const targetMs = Date.parse(isoAt(50));
    const boundary = truncationBoundary(timeline.events, targetMs);
    const truncated = await foldRace(timeline.events.slice(0, boundary), SESSION);
    const scrubbed = foldAt(timeline, targetMs);

    expect(scrubbed).toEqual(truncated.finalState);
    expect(scrubbed.drivers["1"]?.pit_stops).toHaveLength(1);
    expect(leaderLap(scrubbed)).toBe(2);
  });

  it("applies null-source events before the truncation boundary and excludes them after it, across pages", async () => {
    // Same fixture as foldRace.test.ts's null-source regression test, but
    // e2/e4 (before the boundary) land on page 1 and e6 (after it) on page 2.
    const events: RaceEvent[] = [
      event("e1", "laps", 0, { driver_number: 1, lap_number: 1 }),
      { event_id: "e2", endpoint: "race_control", source_time: null, payload: { category: "Flag", message: "before-1" } },
      event("e3", "laps", 10, { driver_number: 1, lap_number: 2 }),
      { event_id: "e4", endpoint: "race_control", source_time: null, payload: { category: "Flag", message: "before-2" } },
      event("e5", "laps", 50, { driver_number: 1, lap_number: 3 }), // the truncation boundary for target=20s
      { event_id: "e6", endpoint: "race_control", source_time: null, payload: { category: "Flag", message: "after" } },
    ];

    const timeline = createTimeline(SESSION);
    await appendEvents(timeline, events.slice(0, 4));
    await appendEvents(timeline, events.slice(4));

    const targetMs = Date.parse(isoAt(20));
    expect(truncationBoundary(timeline.events, targetMs)).toBe(4); // index of e5

    const boundary = truncationBoundary(timeline.events, targetMs);
    const truncated = await foldRace(timeline.events.slice(0, boundary), SESSION);
    const scrubbed = foldAt(timeline, targetMs);

    expect(scrubbed).toEqual(truncated.finalState);
    expect(scrubbed.race_control.recent_messages.map((m) => m.payload["message"])).toEqual([
      "before-1",
      "before-2",
    ]);
    expect(leaderLap(scrubbed)).toBe(2);
  });

  it("appending an empty page is a no-op", async () => {
    const timeline = createTimeline(SESSION);
    await appendEvents(timeline, tenEventFixture().slice(0, 3));
    const before = { ...timeline, events: [...timeline.events], keyframes: [...timeline.keyframes] };

    await appendEvents(timeline, []);

    expect(timeline.events).toEqual(before.events);
    expect(timeline.keyframes).toEqual(before.keyframes);
    expect(timeline.firstSourceMs).toBe(before.firstSourceMs);
    expect(timeline.lastSourceMs).toBe(before.lastSourceMs);
  });
});
