import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { emptyAnchors } from "./anchors.ts";
import { emptyBuffer } from "./buffer.ts";
import { useSessionStatus } from "./selectors.ts";
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
