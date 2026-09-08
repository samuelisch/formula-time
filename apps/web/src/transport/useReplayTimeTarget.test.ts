import type { RaceEvent } from "@formula-time/domain";
import { renderHook } from "@testing-library/react";
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

  it("anchors() is derived from the fold, empty when there is none", () => {
    const { result } = renderHook(() => useReplayTimeTarget(fakePlayback(), null));
    expect(result.current.anchors()).toEqual({ lights_out: null, laps: [], restarts: [] });

    const { result: withFold } = renderHook(() => useReplayTimeTarget(fakePlayback(), folded()));
    expect(withFold.current.anchors().lights_out).toBe("2026-09-06T13:00:00.000Z");
  });
});
