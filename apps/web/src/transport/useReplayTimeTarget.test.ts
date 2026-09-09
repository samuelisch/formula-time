import type { RaceEvent } from "@formula-time/domain";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FoldedRace, LapMarker } from "../replay/foldRace.ts";
import type { ReplayPlayback } from "../replay/useReplayPlayback.ts";
import { deriveReplayAnchors, useReplayTimeTarget } from "./useReplayTimeTarget.ts";

function raceControlEvent(id: string, message: string, date: string): RaceEvent {
  return {
    event_id: id,
    endpoint: "race_control",
    source_time: date,
    payload: { category: "SessionStatus", message, date },
  };
}

function folded(overrides: Partial<FoldedRace> = {}): FoldedRace {
  const lapMarkers: LapMarker[] = overrides.lapMarkers ?? [
    { lap: 1, sourceMs: Date.parse("2026-09-06T13:00:00.000Z") },
    { lap: 2, sourceMs: Date.parse("2026-09-06T13:01:30.000Z") },
  ];
  return {
    session: {},
    events: [],
    keyframes: [],
    finalState: {} as never,
    firstSourceMs: Date.parse("2026-09-06T13:00:00.000Z"),
    lastSourceMs: Date.parse("2026-09-06T13:01:30.000Z"),
    lapMarkers,
    ...overrides,
  };
}

function fakePlayback(overrides: Partial<ReplayPlayback> = {}): ReplayPlayback {
  return {
    push: null,
    sourceMs: 0,
    isPlaying: false,
    startSourceMs: 0,
    endSourceMs: 0,
    lapMarkers: [],
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    jumpToStart: vi.fn(),
    ...overrides,
  };
}

describe("deriveReplayAnchors", () => {
  it("lap N's anchor is the lap marker's source time, and lights_out is lap 1's", () => {
    const anchors = deriveReplayAnchors(folded());
    expect(anchors.lights_out).toBe("2026-09-06T13:00:00.000Z");
    expect(anchors.laps).toEqual([
      { lap: 1, source_time: "2026-09-06T13:00:00.000Z" },
      { lap: 2, source_time: "2026-09-06T13:01:30.000Z" },
    ]);
  });

  it("lights_out is null when lap 1 was never reached", () => {
    const anchors = deriveReplayAnchors(folded({ lapMarkers: [{ lap: 2, sourceMs: 1_000 }] }));
    expect(anchors.lights_out).toBeNull();
  });

  it("restarts are SESSION STARTED race-control events, deduped and sorted", () => {
    const events: RaceEvent[] = [
      raceControlEvent("e1", "SESSION STARTED", "2026-09-06T13:05:00.000Z"),
      raceControlEvent("e2", "SESSION STARTED", "2026-09-06T13:00:00.000Z"), // earlier, out of order
      raceControlEvent("e3", "SESSION STARTED", "2026-09-06T13:00:00.000Z"), // duplicate date
      raceControlEvent("e4", "SAFETY CAR DEPLOYED", "2026-09-06T13:02:00.000Z"), // not a restart
      { event_id: "e5", endpoint: "laps", source_time: "2026-09-06T13:03:00.000Z", payload: { category: "SessionStatus", message: "SESSION STARTED", date: "2026-09-06T13:03:00.000Z" } }, // wrong endpoint
    ];
    const anchors = deriveReplayAnchors(folded({ events }));
    expect(anchors.restarts).toEqual(["2026-09-06T13:00:00.000Z", "2026-09-06T13:05:00.000Z"]);
  });
});

describe("useReplayTimeTarget", () => {
  it("displayedAt() is null when there is no fold, else the playback's sourceMs", () => {
    const { result: withoutFold } = renderHook(() => useReplayTimeTarget(fakePlayback({ sourceMs: 5_000 }), null));
    expect(withoutFold.current.displayedAt()).toBeNull();

    const { result: withFold } = renderHook(() =>
      useReplayTimeTarget(fakePlayback({ sourceMs: 5_000 }), folded()),
    );
    expect(withFold.current.displayedAt()).toBe(5_000);
  });

  it("range() is [startSourceMs, endSourceMs] when folded, else null", () => {
    const playback = fakePlayback({ startSourceMs: 100, endSourceMs: 900 });
    const { result } = renderHook(() => useReplayTimeTarget(playback, folded()));
    expect(result.current.range()).toEqual({ startMs: 100, endMs: 900 });

    const { result: unfolded } = renderHook(() => useReplayTimeTarget(playback, null));
    expect(unfolded.current.range()).toBeNull();
  });

  it("seekTo() delegates to playback.seek()", () => {
    const playback = fakePlayback();
    const { result } = renderHook(() => useReplayTimeTarget(playback, folded()));
    result.current.seekTo(12_345);
    expect(playback.seek).toHaveBeenCalledWith(12_345);
  });

  it("nudge() seeks relative to the current position", () => {
    const playback = fakePlayback({ sourceMs: 10_000 });
    const { result } = renderHook(() => useReplayTimeTarget(playback, folded()));
    result.current.nudge(5_000);
    expect(playback.seek).toHaveBeenCalledWith(15_000);
    result.current.nudge(-2_000);
    expect(playback.seek).toHaveBeenCalledWith(8_000);
  });

  it("playback() always returns a non-null play/pause handle wrapping the underlying playback", () => {
    const playback = fakePlayback({ isPlaying: true });
    const { result } = renderHook(() => useReplayTimeTarget(playback, folded()));
    const handle = result.current.playback();
    expect(handle).not.toBeNull();
    expect(handle!.playing).toBe(true);
    handle!.pause();
    expect(playback.pause).toHaveBeenCalled();
  });

  it("notice() is always null -- a replay holds the whole fold, so no position is a fallback", () => {
    const { result } = renderHook(() => useReplayTimeTarget(fakePlayback(), folded()));
    expect(result.current.notice()).toBeNull();

    const { result: unfolded } = renderHook(() => useReplayTimeTarget(fakePlayback(), null));
    expect(unfolded.current.notice()).toBeNull();
  });

  it("anchors() is derived from the fold, empty when there is none", () => {
    const { result } = renderHook(() => useReplayTimeTarget(fakePlayback(), null));
    expect(result.current.anchors()).toEqual({ lights_out: null, laps: [], restarts: [] });

    const { result: withFold } = renderHook(() => useReplayTimeTarget(fakePlayback(), folded()));
    expect(withFold.current.anchors().lights_out).toBe("2026-09-06T13:00:00.000Z");
  });

  // Un-nudged sync offset (issue #67): a net accumulator over every
  // `seekTo`/`nudge` call, not a wall-clock computation -- ticking while
  // playing moves `playback.sourceMs` (simulated here by re-rendering with
  // an updated fake) without ever calling `seekTo`/`nudge`, so it must never
  // move the offset.
  describe("syncOffsetMs()", () => {
    it("is null with no fold, 0 for a fold that has never been seeked", () => {
      const { result: unfolded } = renderHook(() => useReplayTimeTarget(fakePlayback(), null));
      expect(unfolded.current.syncOffsetMs?.()).toBeNull();

      const { result } = renderHook(() =>
        useReplayTimeTarget(fakePlayback({ startSourceMs: 0, endSourceMs: 90_000 }), folded()),
      );
      expect(result.current.syncOffsetMs?.()).toBe(0);
    });

    it("steps by exactly how far seekTo/nudge moved the (clamped) position", () => {
      const playback = fakePlayback({ sourceMs: 10_000, startSourceMs: 0, endSourceMs: 90_000 });
      const race = folded(); // one stable reference across re-renders, same as the fold-change tests below
      const { result } = renderHook(() => useReplayTimeTarget(playback, race));

      act(() => result.current.seekTo(25_000)); // +15_000
      expect(result.current.syncOffsetMs?.()).toBe(15_000);

      playback.sourceMs = 25_000; // simulate the seek having landed
      act(() => result.current.nudge(-5_000)); // +(-5_000)
      expect(result.current.syncOffsetMs?.()).toBe(10_000);

      playback.sourceMs = 20_000;
      act(() => result.current.seekTo(200_000)); // clamped to endSourceMs (90_000): +70_000, not +180_000
      expect(result.current.syncOffsetMs?.()).toBe(80_000);
    });

    it("is unaffected by plain playback ticking (sourceMs changing with no seekTo/nudge call)", () => {
      const race = folded(); // one stable reference across rerenders -- see the fold-change test below
      const playback = fakePlayback({ sourceMs: 10_000, startSourceMs: 0, endSourceMs: 90_000 });
      const { result, rerender } = renderHook(({ p }: { p: ReplayPlayback }) => useReplayTimeTarget(p, race), {
        initialProps: { p: playback },
      });
      expect(result.current.syncOffsetMs?.()).toBe(0);

      const ticked = { ...playback, sourceMs: 40_000 };
      rerender({ p: ticked });
      expect(result.current.syncOffsetMs?.()).toBe(0);
    });

    it("resets to 0 when the fold changes", () => {
      const playback = fakePlayback({ sourceMs: 10_000, startSourceMs: 0, endSourceMs: 90_000 });
      const raceOne = folded();
      const { result, rerender } = renderHook(({ f }: { f: FoldedRace | null }) => useReplayTimeTarget(playback, f), {
        initialProps: { f: raceOne },
      });
      act(() => result.current.seekTo(30_000));
      expect(result.current.syncOffsetMs?.()).toBe(20_000);

      const raceTwo = folded({ firstSourceMs: 500, lastSourceMs: 5_000, lapMarkers: [] });
      rerender({ f: raceTwo });
      expect(result.current.syncOffsetMs?.()).toBe(0);
    });

    it("resets to 0 on a revisit to the same fold object (e.g. a cached TanStack Query result)", () => {
      const playback = fakePlayback({ sourceMs: 10_000, startSourceMs: 0, endSourceMs: 90_000 });
      const raceOne = folded();
      const raceTwo = folded({ firstSourceMs: 500, lastSourceMs: 5_000, lapMarkers: [] });
      const { result, rerender } = renderHook(({ f }: { f: FoldedRace | null }) => useReplayTimeTarget(playback, f), {
        initialProps: { f: raceOne },
      });

      act(() => result.current.seekTo(30_000));
      expect(result.current.syncOffsetMs?.()).toBe(20_000);

      rerender({ f: raceTwo });
      expect(result.current.syncOffsetMs?.()).toBe(0);

      // Revisit raceOne -- same object reference as before, not a new fold.
      rerender({ f: raceOne });
      expect(result.current.syncOffsetMs?.()).toBe(0);
    });
  });
});
