import { describe, expect, it, vi } from "vitest";

import type { Anchors } from "../live/anchors.ts";
import { jumpToRaceStart } from "./raceStart.ts";
import type { TimeTarget } from "./TimeTarget.ts";

const NO_ANCHORS: Anchors = { lights_out: null, laps: [], restarts: [] };
const ANCHORS_WITH_LIGHTS_OUT: Anchors = {
  lights_out: "2026-09-06T13:00:00.000Z",
  laps: [{ lap: 1, source_time: "2026-09-06T13:00:00.000Z" }],
  restarts: [],
};

function fakeTarget(overrides: { anchors?: Anchors; playback?: { playing: boolean; play(): void; pause(): void } | null }): TimeTarget {
  return {
    displayedAt: () => null,
    seekTo: vi.fn(),
    nudge: vi.fn(),
    anchors: () => overrides.anchors ?? NO_ANCHORS,
    range: () => null,
    playback: () => overrides.playback ?? null,
    notice: () => null,
    syncOffsetMs: () => null,
    rewindMode: () => null,
  };
}

describe("jumpToRaceStart", () => {
  it("returns false and does not seek when there is no lights-out anchor", () => {
    const target = fakeTarget({ anchors: NO_ANCHORS });
    expect(jumpToRaceStart(target)).toBe(false);
    expect(target.seekTo).not.toHaveBeenCalled();
  });

  it("seeks to the lights-out anchor and returns true, pausing when playback() is non-null", () => {
    const pause = vi.fn();
    const target = fakeTarget({
      anchors: ANCHORS_WITH_LIGHTS_OUT,
      playback: { playing: true, play: vi.fn(), pause },
    });

    expect(jumpToRaceStart(target)).toBe(true);
    expect(target.seekTo).toHaveBeenCalledWith(Date.parse("2026-09-06T13:00:00.000Z"));
    expect(pause).toHaveBeenCalled();
  });

  it("seeks to the lights-out anchor without calling pause when playback() is null", () => {
    const target = fakeTarget({ anchors: ANCHORS_WITH_LIGHTS_OUT, playback: null });
    expect(jumpToRaceStart(target)).toBe(true);
    expect(target.seekTo).toHaveBeenCalledWith(Date.parse("2026-09-06T13:00:00.000Z"));
  });
});
