import { describe, expect, it, vi } from "vitest";

import type { Anchors } from "../live/anchors.ts";
import type { TimeTarget } from "../transport/TimeTarget.ts";
import { createReadingTrackers, handleLapRead, handleLightsOutRead, type ReadingContext } from "./applyOffset.ts";

const NO_ANCHORS: Anchors = { lights_out: null, laps: [], restarts: [] };

function fakeTarget(overrides: Partial<TimeTarget> = {}): TimeTarget {
  return {
    displayedAt: () => null,
    seekTo: vi.fn(),
    nudge: vi.fn(),
    anchors: () => NO_ANCHORS,
    range: () => ({ startMs: 0, endMs: 100_000 }),
    playback: () => null,
    notice: () => null,
    syncOffsetMs: () => 0,
    rewindMode: () => "edge",
    ...overrides,
  };
}

function ctx(overrides: Partial<ReadingContext> = {}): ReadingContext {
  return { anchors: NO_ANCHORS, target: fakeTarget(), pipelineBiasMs: 0, ...overrides };
}

describe("handleLapRead: sequences the lap tracker, the lock/apply policy, and the offset tracker", () => {
  it("a first read at lap 1 with no lights_out anchor applies immediately (lap 1's own lock IS the anchored event)", () => {
    const trackers = createReadingTrackers();
    const anchors: Anchors = { lights_out: "2026-09-06T13:00:00.000Z", laps: [], restarts: [] };
    const target = fakeTarget();
    const status = handleLapRead(1, 1_000, trackers, ctx({ anchors, target }));
    expect(status).toMatch(/^Lap 1: /);
    expect(target.seekTo).toHaveBeenCalledTimes(1);
  });

  it("a first read at a lap other than 1 locks without applying -- not time-anchored", () => {
    const trackers = createReadingTrackers();
    const target = fakeTarget();
    const status = handleLapRead(5, 1_000, trackers, ctx({ target }));
    expect(status).toBe("Locked on lap 5 — aligning at the next lap change");
    expect(target.seekTo).not.toHaveBeenCalled();
  });

  it("the same lap read again is ignored (null, no status change)", () => {
    const trackers = createReadingTrackers();
    handleLapRead(5, 1_000, trackers, ctx());
    const status = handleLapRead(5, 2_000, trackers, ctx());
    expect(status).toBeNull();
  });

  it("a non-consecutive lap is rejected, held at the last locked position", () => {
    const trackers = createReadingTrackers();
    handleLapRead(5, 1_000, trackers, ctx());
    const status = handleLapRead(9, 2_000, trackers, ctx());
    expect(status).toMatch(/expected 6/);
  });

  it("a flip (lastLap + 1) with a known anchor applies and seeks the target", () => {
    const trackers = createReadingTrackers();
    handleLapRead(5, 1_000, trackers, ctx()); // locks on 5, unanchored
    const anchors: Anchors = { lights_out: null, laps: [{ lap: 6, source_time: "2026-09-06T13:00:10.000Z" }], restarts: [] };
    const target = fakeTarget();
    const status = handleLapRead(6, 2_000, trackers, ctx({ anchors, target }));
    expect(status).toMatch(/^Lap 6: /);
    expect(target.seekTo).toHaveBeenCalledTimes(1);
  });

  // A replay target's seekTo(atMs) places the playback clock directly on
  // the source-time axis (useReplayTimeTarget.ts passes it straight to
  // playback.seek), so the value handleLapRead calls it with IS the
  // landing position -- this measures that landing directly against the
  // flipped-to lap's own marker, standing in for a live screen-share
  // capture (this environment can't drive a real getDisplayMedia track).
  it("a 14->15 flip lands the seek within 1.5s of lap 15's own marker", () => {
    const perfNow = vi.spyOn(performance, "now").mockReturnValue(5_000);
    try {
      const trackers = createReadingTrackers();
      const lap15Marker = "2026-09-06T13:12:34.000Z";
      const anchorsAtLap14: Anchors = { lights_out: null, laps: [{ lap: 14, source_time: "2026-09-06T13:11:00.000Z" }], restarts: [] };
      handleLapRead(14, 4_800, trackers, ctx({ anchors: anchorsAtLap14 })); // locks on 14, unanchored -- lap 14 isn't lap 1

      const anchors: Anchors = {
        lights_out: null,
        laps: [
          { lap: 14, source_time: "2026-09-06T13:11:00.000Z" },
          { lap: 15, source_time: lap15Marker },
        ],
        restarts: [],
      };
      const target = fakeTarget();
      // 100ms of handling time between the frame grab (frameAt) and this
      // call's performance.now() -- compensateTarget's job is exactly to
      // absorb this, which is what the 1.5s tolerance below is checking.
      const status = handleLapRead(15, 4_900, trackers, ctx({ anchors, target }));

      expect(status).toMatch(/^Lap 15: /);
      const seekTo = vi.mocked(target.seekTo);
      expect(seekTo).toHaveBeenCalledTimes(1);
      const landedAtMs = seekTo.mock.calls[0]![0];
      const deltaMs = Math.abs(landedAtMs - Date.parse(lap15Marker));
      expect(deltaMs).toBeLessThanOrEqual(1_500);
    } finally {
      perfNow.mockRestore();
    }
  });
});

describe("handleLightsOutRead: always an anchored observation, no lock phase", () => {
  it("applies against the lights_out anchor and labels a genuine start", () => {
    const trackers = createReadingTrackers();
    const anchors: Anchors = { lights_out: "2026-09-06T13:00:00.000Z", laps: [], restarts: [] };
    const target = fakeTarget();
    const status = handleLightsOutRead(1_000, false, trackers, ctx({ anchors, target }));
    expect(status).toMatch(/^Lights out: /);
    expect(target.seekTo).toHaveBeenCalledTimes(1);
  });

  it("labels a restart differently and reads the latest restart anchor", () => {
    const trackers = createReadingTrackers();
    const anchors: Anchors = { lights_out: "2026-09-06T13:00:00.000Z", laps: [], restarts: ["2026-09-06T13:05:00.000Z"] };
    const target = fakeTarget();
    const status = handleLightsOutRead(1_000, true, trackers, ctx({ anchors, target }));
    expect(status).toMatch(/^Restart lights out: /);
    expect(target.seekTo).toHaveBeenCalledTimes(1);
  });

  it("with no anchor yet, reports so and never touches the target", () => {
    const trackers = createReadingTrackers();
    const target = fakeTarget();
    const status = handleLightsOutRead(1_000, false, trackers, ctx({ target }));
    expect(status).toBe("Lights out — no anchor yet, will retry at the next lap");
    expect(target.seekTo).not.toHaveBeenCalled();
  });
});
