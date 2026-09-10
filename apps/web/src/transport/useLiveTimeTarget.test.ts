import type { RaceEvent, RawRecord } from "@formula-time/domain";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { emptyAnchors, type Anchors } from "../live/anchors.ts";
import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import { appendEvents, createTimeline, foldAt, type Timeline } from "../replay/timeline.ts";
import { makePush } from "../test/fixtures.ts";
import { BUFFER_SHORT_NOTICE, useLiveTimeTarget } from "./useLiveTimeTarget.ts";

function resetStore(overrides: Partial<ReturnType<typeof useLiveStore.getState>> = {}): void {
  useLiveStore.setState({
    connection: "connecting",
    catchingUp: false,
    lastMessageAt: null,
    live: null,
    buffer: emptyBuffer(),
    delayMs: 0,
    displayed: null,
    bufferShort: false,
    anchors: emptyAnchors(),
    timeline: null,
    mode: "edge",
    ...overrides,
  });
}

const TIMELINE_SESSION: RawRecord = {
  session_key: 9999,
  name: "Race",
  country: "Italy",
  circuit_key: 39,
  date_start: "2026-09-08T12:00:00.000Z",
  date_end: "2026-09-08T14:00:00.000Z",
  total_laps: 58,
  status: "live",
};

function isoAt(offsetSeconds: number): string {
  return new Date(Date.parse("2026-09-08T12:00:00.000Z") + offsetSeconds * 1000).toISOString();
}

function timelineEvent(id: string, endpoint: string, offsetSeconds: number, payload: RawRecord): RaceEvent {
  return { event_id: id, endpoint, source_time: isoAt(offsetSeconds), payload };
}

async function buildTimeline(): Promise<Timeline> {
  const timeline = createTimeline(TIMELINE_SESSION);
  await appendEvents(timeline, [
    timelineEvent("t1", "position", 0, { driver_number: 1, position: 1 }),
    timelineEvent("t2", "laps", 0, { driver_number: 1, lap_number: 1 }),
    timelineEvent("t3", "laps", 40, { driver_number: 1, lap_number: 2 }),
  ]);
  return timeline;
}

const bufferedSpan = { entries: [{ at: 0, raw: "{}" }, { at: 180_000, raw: "{}" }] };

const anchorsWithLap5: Anchors = {
  lights_out: "2000-01-01T00:00:00.000Z",
  laps: [{ lap: 5, source_time: "2000-01-01T00:00:00.000Z" }],
  restarts: [],
};

const NOW = 200_000;

describe("useLiveTimeTarget", () => {
  beforeEach(() => {
    resetStore();
  });

  it("displayedAt() is null before any push, and the push's axis time once one arrives", () => {
    resetStore({ buffer: bufferedSpan });
    const { result } = renderHook(() => useLiveTimeTarget(() => NOW));
    expect(result.current.displayedAt()).toBeNull();

    resetStore({
      buffer: bufferedSpan,
      displayed: {
        type: "state",
        seq: "1",
        sent_at: 1_000,
        session_key: "9999",
        total_laps: null,
        state: { latest_source_time: "2026-09-08T13:00:00.000Z" } as never,
        polls: [],
      },
    });
    const { result: result2 } = renderHook(() => useLiveTimeTarget(() => NOW));
    expect(result2.current.displayedAt()).toBe(Date.parse("2026-09-08T13:00:00.000Z"));
  });

  it("range() is [now - spanMs, now]", () => {
    resetStore({ buffer: bufferedSpan });
    const { result } = renderHook(() => useLiveTimeTarget(() => NOW));
    expect(result.current.range()).toEqual({ startMs: NOW - 180_000, endMs: NOW });
  });

  it("playback() is null on live", () => {
    const { result } = renderHook(() => useLiveTimeTarget(() => NOW));
    expect(result.current.playback()).toBeNull();
  });

  it("nudge() changes the delay by -delta, floored at zero", () => {
    resetStore({ buffer: bufferedSpan });
    const { result } = renderHook(() => useLiveTimeTarget(() => NOW));

    result.current.nudge(5_000); // forward => less delay
    expect(useLiveStore.getState().delayMs).toBe(0); // already 0, floored

    resetStore({ buffer: bufferedSpan, delayMs: 10_000 });
    const { result: result2 } = renderHook(() => useLiveTimeTarget(() => NOW));
    act(() => result2.current.nudge(4_000));
    expect(useLiveStore.getState().delayMs).toBe(6_000);

    act(() => result2.current.nudge(-3_000));
    expect(useLiveStore.getState().delayMs).toBe(9_000);
  });

  it("seekTo() sets the delay from the target source time, floored at zero", () => {
    resetStore({ buffer: bufferedSpan });
    const { result } = renderHook(() => useLiveTimeTarget(() => NOW));

    result.current.seekTo(NOW - 5_000);
    expect(useLiveStore.getState().delayMs).toBe(5_000);

    result.current.seekTo(NOW); // the live edge => delay 0
    expect(useLiveStore.getState().delayMs).toBe(0);

    result.current.seekTo(NOW + 1_000); // past "now" => floored to 0
    expect(useLiveStore.getState().delayMs).toBe(0);
  });

  // Fix round 1 on PR #110: no upper clamp to the buffered span (removed --
  // the pre-#67 direct `setDelayMs` call had none either). A delay asking
  // for older history than this tab has buffered is exactly what the
  // store's own `bufferShort`/`reselect` is for: it falls back to the
  // oldest buffered entry and `notice()` surfaces the warning, rather than
  // `seekTo` silently capping the delay to the span.
  it("seekTo() past the buffered span sets the full delay and lets the store fall back to the oldest push", () => {
    // `live` (`reselect`'s liveAxis) must be set for the store to actually
    // fall back rather than short-circuit to `{ displayed: null,
    // bufferShort: false }`, and the fallback entry's `raw` must be a real
    // encoded push -- once it becomes `displayed`, this hook's own
    // `axisOf(displayed)` parses it on every render -- axis pinned to NOW
    // via `sent_at` (no source time), matching `bufferedSpan`'s own axis.
    function pushAt(atMs: number): { at: number; raw: string } {
      return { at: atMs, raw: JSON.stringify(makePush({ sent_at: atMs }, { latest_source_time: null })) };
    }
    resetStore({
      buffer: { entries: [pushAt(0), pushAt(180_000)] },
      live: makePush({ sent_at: NOW }, { latest_source_time: null }),
    });
    const { result } = renderHook(() => useLiveTimeTarget(() => NOW));

    act(() => result.current.seekTo(NOW - 1_000_000)); // far before the buffer

    expect(useLiveStore.getState().delayMs).toBe(1_000_000); // not clamped to spanMs (180_000)
    expect(useLiveStore.getState().bufferShort).toBe(true);
    expect(result.current.notice()).toBe(BUFFER_SHORT_NOTICE);
  });

  it("notice() carries the buffered-delay warning exactly when the store reports bufferShort", () => {
    // The warning the deleted `DelayControl` rendered; without a slot on the
    // seam it went dead (fix round 4 on PR #87), so a delay past the buffered
    // span silently showed the oldest entry as if it were what was asked for.
    resetStore({ buffer: bufferedSpan, bufferShort: false });
    const { result } = renderHook(() => useLiveTimeTarget(() => NOW));
    expect(result.current.notice()).toBeNull();

    resetStore({ buffer: bufferedSpan, delayMs: 500_000, bufferShort: true });
    const { result: short } = renderHook(() => useLiveTimeTarget(() => NOW));
    expect(short.current.notice()).toBe("Delay exceeds what this tab has buffered; showing the oldest");
    expect(short.current.notice()).toBe(BUFFER_SHORT_NOTICE);
  });

  it("anchors() returns the store's anchors when there is no timeline", () => {
    resetStore({ buffer: bufferedSpan, anchors: anchorsWithLap5 });
    const { result } = renderHook(() => useLiveTimeTarget(() => NOW));
    expect(result.current.anchors()).toEqual(anchorsWithLap5);
  });

  describe("issue #97: timeline mode", () => {
    const BASE_MS = Date.parse("2026-09-08T12:00:00.000Z");
    const NOW_TL = BASE_MS + 200_000; // 200s offset

    function pushAt(atMs: number): { at: number; raw: string } {
      return { at: atMs, raw: JSON.stringify(makePush({ sent_at: atMs }, { latest_source_time: null })) };
    }

    it("range() is [timeline.firstSourceMs, now] once a timeline is loaded", async () => {
      const timeline = await buildTimeline();
      resetStore({ buffer: bufferedSpan, timeline });
      const { result } = renderHook(() => useLiveTimeTarget(() => NOW));
      expect(result.current.range()).toEqual({ startMs: timeline.firstSourceMs, endMs: NOW });
    });

    it("anchors() comes from the timeline when one is loaded, overriding the stream-derived anchors", async () => {
      const timeline = await buildTimeline();
      resetStore({ buffer: bufferedSpan, anchors: anchorsWithLap5, timeline });
      const { result } = renderHook(() => useLiveTimeTarget(() => NOW));
      const anchors = result.current.anchors();
      expect(anchors).not.toEqual(anchorsWithLap5);
      expect(anchors.lights_out).toBe(isoAt(0));
      expect(anchors.laps.map((a) => a.lap)).toEqual([1, 2]);
    });

    it("seekTo() inside the buffer sets the delay and leaves mode buffer even with a timeline loaded", async () => {
      const timeline = await buildTimeline();
      resetStore({
        buffer: { entries: [pushAt(BASE_MS + 190_000), pushAt(BASE_MS + 200_000)] },
        live: makePush({ sent_at: NOW_TL }, { latest_source_time: null }),
        timeline,
      });
      const { result } = renderHook(() => useLiveTimeTarget(() => NOW_TL));
      act(() => result.current.seekTo(NOW_TL - 5_000));
      expect(useLiveStore.getState().mode).toBe("buffer");
      expect(result.current.rewindMode()).toBe("buffer");
    });

    it("seekTo() beyond the buffer enters timeline mode; displayedAt() matches the folded state", async () => {
      const timeline = await buildTimeline();
      resetStore({
        buffer: { entries: [pushAt(BASE_MS + 190_000), pushAt(BASE_MS + 200_000)] },
        live: makePush({ sent_at: NOW_TL }, { latest_source_time: null }),
        timeline,
      });
      const { result } = renderHook(() => useLiveTimeTarget(() => NOW_TL));

      act(() => result.current.seekTo(BASE_MS + 50_000)); // 50s offset, past the buffer's [190s, 200s] window

      expect(result.current.rewindMode()).toBe("timeline");
      const expected = foldAt(timeline, BASE_MS + 50_000);
      expect(expected.latest_source_time).not.toBeNull();
      expect(result.current.displayedAt()).toBe(Date.parse(expected.latest_source_time!));
    });

    it("nudging forward until the target re-enters the buffer returns mode to buffer", async () => {
      const timeline = await buildTimeline();
      resetStore({
        buffer: { entries: [pushAt(BASE_MS + 190_000), pushAt(BASE_MS + 200_000)] },
        live: makePush({ sent_at: NOW_TL }, { latest_source_time: null }),
        timeline,
      });
      const { result } = renderHook(() => useLiveTimeTarget(() => NOW_TL));

      act(() => result.current.seekTo(BASE_MS + 50_000)); // enters timeline mode, delay 150_000
      expect(result.current.rewindMode()).toBe("timeline");

      act(() => result.current.nudge(145_000)); // delay -> 5_000, target -> 195s offset, inside [190s, 200s]
      expect(result.current.rewindMode()).toBe("buffer");
    });

    it("seekTo(range().endMs) (the Live button) resets to the live edge", async () => {
      const timeline = await buildTimeline();
      resetStore({ timeline, live: makePush({ sent_at: NOW_TL }, { latest_source_time: null }) });
      const { result } = renderHook(() => useLiveTimeTarget(() => NOW_TL));

      act(() => result.current.seekTo(result.current.range()!.endMs));
      expect(result.current.rewindMode()).toBe("edge");
    });

    it("notice() is null in timeline mode even if the store's bufferShort is stale-true", () => {
      resetStore({ mode: "timeline", bufferShort: true });
      const { result } = renderHook(() => useLiveTimeTarget(() => NOW));
      expect(result.current.notice()).toBeNull();
    });

    it("rewindMode() mirrors the store's mode", () => {
      resetStore({ mode: "buffer" });
      const { result: buffer } = renderHook(() => useLiveTimeTarget(() => NOW));
      expect(buffer.current.rewindMode()).toBe("buffer");

      resetStore({ mode: "timeline" });
      const { result: timeline } = renderHook(() => useLiveTimeTarget(() => NOW));
      expect(timeline.current.rewindMode()).toBe("timeline");

      resetStore({ mode: "edge" });
      const { result: edge } = renderHook(() => useLiveTimeTarget(() => NOW));
      expect(edge.current.rewindMode()).toBe("edge");
    });
  });
});
