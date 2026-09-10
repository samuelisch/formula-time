import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createTimeline } from "../replay/timeline.ts";
import { emptyAnchors } from "./anchors.ts";
import { emptyBuffer } from "./buffer.ts";
import { useLiveSessionKey, useLiveSessionStatus, useRewindMode, useSessionStatus, useTimeline } from "./selectors.ts";
import { useLiveStore } from "./store.ts";
import type { LivePush } from "./types.ts";

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

function pushWithSession(session: Record<string, unknown> | null): LivePush {
  return {
    type: "state",
    seq: "1",
    sent_at: 0,
    session_key: "9999",
    total_laps: 58,
    state: {
      sequence: 1,
      latest_source_time: null,
      session,
      drivers: {},
      driver_order: [],
      race_control: {
        session_status: null,
        current_flag: null,
        safety_car: null,
        active_flags: {},
        driver_flags: {},
        recent_messages: [],
      },
      weather: null,
      anomalies: { duplicate_events: 0, stale_updates: 0, missing_driver: 0, unsupported_events: 0 },
    },
    polls: [],
  };
}

describe("useSessionStatus", () => {
  it("returns null before any push has arrived", () => {
    resetStore();
    const { result } = renderHook(() => useSessionStatus());
    expect(result.current).toBeNull();
  });

  it.each(["upcoming", "live", "finished"] as const)("returns %s from the displayed session's status field", (status) => {
    resetStore({ displayed: pushWithSession({ status }) });
    const { result } = renderHook(() => useSessionStatus());
    expect(result.current).toBe(status);
  });

  it("returns null for an unrecognised status value (string-guarded)", () => {
    resetStore({ displayed: pushWithSession({ status: "Started" }) });
    const { result } = renderHook(() => useSessionStatus());
    expect(result.current).toBeNull();
  });

  it("returns null when the session itself is null", () => {
    resetStore({ displayed: pushWithSession(null) });
    const { result } = renderHook(() => useSessionStatus());
    expect(result.current).toBeNull();
  });
});

describe("useRewindMode", () => {
  it("reads the store's mode", () => {
    resetStore({ mode: "timeline" });
    const { result } = renderHook(() => useRewindMode());
    expect(result.current).toBe("timeline");
  });
});

describe("useTimeline", () => {
  it("is null before a timeline is loaded", () => {
    resetStore();
    const { result } = renderHook(() => useTimeline());
    expect(result.current).toBeNull();
  });

  it("is null when the timeline's session does not match the live push's, even though one is loaded", () => {
    const mismatchedTimeline = createTimeline({ session_key: 1111 }); // live push's session_key is "9999"
    resetStore({ live: pushWithSession({ status: "live" }), timeline: mismatchedTimeline });

    const { result } = renderHook(() => useTimeline());
    expect(result.current).toBeNull();
  });

  it("is null when live is null, even if a timeline is loaded", () => {
    const timeline = createTimeline({ session_key: 9999 });
    resetStore({ live: null, timeline });

    const { result } = renderHook(() => useTimeline());
    expect(result.current).toBeNull();
  });

  it("returns the timeline once it matches the live push's session", () => {
    const timeline = createTimeline({ session_key: 9999 }); // live push's session_key is "9999"
    resetStore({ live: pushWithSession({ status: "live" }), timeline });

    const { result } = renderHook(() => useTimeline());
    expect(result.current).toBe(timeline);
  });
});

describe("useLiveSessionKey / useLiveSessionStatus", () => {
  it("read the live push, not the displayed one", () => {
    resetStore({
      live: pushWithSession({ status: "live" }),
      displayed: pushWithSession({ status: "finished" }), // simulating timeline mode's synthesised displayed push
    });
    const { result: key } = renderHook(() => useLiveSessionKey());
    expect(key.current).toBe(9999);

    const { result: status } = renderHook(() => useLiveSessionStatus());
    expect(status.current).toBe("live");
  });

  it("are null before any push has arrived", () => {
    resetStore();
    const { result: key } = renderHook(() => useLiveSessionKey());
    expect(key.current).toBeNull();
    const { result: status } = renderHook(() => useLiveSessionStatus());
    expect(status.current).toBeNull();
  });
});
