import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { emptyAnchors, type Anchors } from "../live/anchors.ts";
import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
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
    ...overrides,
  });
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

  it("seekTo() sets the delay from the target source time, clamped to the buffered span", () => {
    resetStore({ buffer: bufferedSpan });
    const { result } = renderHook(() => useLiveTimeTarget(() => NOW));

    result.current.seekTo(NOW - 5_000);
    expect(useLiveStore.getState().delayMs).toBe(5_000);

    result.current.seekTo(NOW); // the live edge => delay 0
    expect(useLiveStore.getState().delayMs).toBe(0);

    result.current.seekTo(NOW - 1_000_000); // far before the buffer => clamped to spanMs
    expect(useLiveStore.getState().delayMs).toBe(180_000);

    result.current.seekTo(NOW + 1_000); // past "now" => clamped to 0
    expect(useLiveStore.getState().delayMs).toBe(0);
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

  it("anchors() returns the store's anchors", () => {
    resetStore({ buffer: bufferedSpan, anchors: anchorsWithLap5 });
    const { result } = renderHook(() => useLiveTimeTarget(() => NOW));
    expect(result.current.anchors()).toEqual(anchorsWithLap5);
  });
});
