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
