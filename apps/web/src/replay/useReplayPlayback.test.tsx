// useReplayPlayback wires PlaybackClock (playbackClock.test.ts covers the
// clock's own math) to React's requestAnimationFrame. This mounts the
// hook, waits (an idle gap), plays, ticks exactly one frame, and asserts
// the position moved by that one frame's worth -- not by the
// mount-to-play gap.
import type { RaceEvent, RawRecord } from "@formula-time/domain";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { foldRace, type FoldedRace } from "./foldRace.ts";
import { useReplayPlayback } from "./useReplayPlayback.ts";

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

const EVENTS: RaceEvent[] = [
  event("e1", "position", 0, { driver_number: 1, position: 1 }),
  event("e2", "laps", 0, { driver_number: 1, lap_number: 1 }),
  event("e3", "laps", 50, { driver_number: 1, lap_number: 2 }),
];

async function foldFixture(): Promise<FoldedRace> {
  return foldRace(EVENTS, SESSION);
}

describe("useReplayPlayback", () => {
  let nowMs: number;
  let rafCallbacks: Array<(t: number) => void>;

  beforeEach(() => {
    nowMs = 0;
    rafCallbacks = [];
    vi.stubGlobal("performance", { now: () => nowMs });
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Advances the stubbed wall clock to `atMs` and fires exactly the frames queued so far. */
  function fireFrame(atMs: number): void {
    nowMs = atMs;
    const due = rafCallbacks;
    rafCallbacks = [];
    for (const cb of due) cb(nowMs);
  }

  it("advances by one frame's worth after play(), not by the mount-to-play idle gap", async () => {
    const folded = await foldFixture();
    const { result } = renderHook(() => useReplayPlayback(folded));

    const start = result.current.sourceMs;
    expect(start).toBe(folded.firstSourceMs);

    // Idle gap between mount and pressing play -- nothing ticks during it
    // (the rAF loop only runs while isPlaying), mirroring a viewer who loads
    // the page and waits a while before pressing Play.
    nowMs = 5_000;

    act(() => {
      result.current.play();
    });
    expect(result.current.isPlaying).toBe(true);

    // One frame, shortly after play().
    act(() => {
      fireFrame(5_100);
    });

    // Only the 100ms since play() should have counted, not the 5000ms
    // mount-to-play gap.
    expect(result.current.sourceMs).toBe(start + 100);
  });
});
