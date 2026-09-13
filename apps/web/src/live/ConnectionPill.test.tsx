import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyBuffer } from "./buffer.ts";
import { useLiveStore } from "./store.ts";
import type { LivePush } from "./types.ts";
import { ConnectionPill } from "./ConnectionPill.tsx";

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
    ...overrides,
  });
}

function displayedWithSession(session: Record<string, unknown> | null): LivePush {
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

// CSS Modules hash class names (e.g. `_live_ab12c`); match on the tone
// fragment rather than an exact class so this survives a hash change.
function pillToneOf(text: string | RegExp): "neutral" | "live" | "warn" {
  const pill = screen.getByText(text);
  if (/_live_/.test(pill.className)) return "live";
  if (/_warn_/.test(pill.className)) return "warn";
  return "neutral";
}

describe("ConnectionPill", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders nothing when there is no session", () => {
    render(<ConnectionPill />);
    expect(screen.queryByText(/connected|connecting|catching up|reconnecting|last update/i)).not.toBeInTheDocument();
  });

  it("renders nothing when the session is upcoming", () => {
    resetStore({ connection: "open", lastMessageAt: Date.now(), displayed: displayedWithSession({ status: "upcoming" }) });
    render(<ConnectionPill />);
    expect(screen.queryByText(/connected|connecting|catching up|reconnecting|last update/i)).not.toBeInTheDocument();
  });

  it("renders nothing when the session has finished", () => {
    resetStore({ connection: "open", lastMessageAt: Date.now(), displayed: displayedWithSession({ status: "finished" }) });
    render(<ConnectionPill />);
    expect(screen.queryByText(/connected|connecting|catching up|reconnecting|last update/i)).not.toBeInTheDocument();
  });

  it("shows connecting… while the stream has not opened yet, on a live session", () => {
    resetStore({ connection: "connecting", displayed: displayedWithSession({ status: "live" }) });
    render(<ConnectionPill />);
    expect(screen.getByText("connecting…")).toBeInTheDocument();
    expect(pillToneOf("connecting…")).toBe("neutral");
  });

  it("shows Live · connected once open with no catch-up and a recent message", () => {
    resetStore({ connection: "open", lastMessageAt: Date.now(), displayed: displayedWithSession({ status: "live" }) });
    render(<ConnectionPill />);
    expect(screen.getByText("Live · connected")).toBeInTheDocument();
    expect(pillToneOf("Live · connected")).toBe("live");
  });

  it("shows Live · catching up while the fanout is replaying a live session", () => {
    resetStore({
      connection: "open",
      catchingUp: true,
      lastMessageAt: Date.now(),
      displayed: displayedWithSession({ status: "live" }),
    });
    render(<ConnectionPill />);
    expect(screen.getByText("Live · catching up")).toBeInTheDocument();
    expect(pillToneOf("Live · catching up")).toBe("live");
  });

  it("shows Live · reconnecting… when the connection drops mid live session", () => {
    resetStore({ connection: "reconnecting", displayed: displayedWithSession({ status: "live" }) });
    render(<ConnectionPill />);
    expect(screen.getByText("Live · reconnecting…")).toBeInTheDocument();
    expect(pillToneOf("Live · reconnecting…")).toBe("warn");
  });

  it("shows a quiet-feed pill once a live feed has been silent for 5s or more", () => {
    resetStore({
      connection: "open",
      lastMessageAt: Date.now() - 6_000,
      displayed: displayedWithSession({ status: "live" }),
    });
    render(<ConnectionPill />);
    expect(screen.getByText(/Live · last update \d+s ago/)).toBeInTheDocument();
    expect(pillToneOf(/Live · last update \d+s ago/)).toBe("live");
  });

  // The visible pill ticks once a second so "last update Ns ago" keeps
  // advancing; a screen reader must not re-announce every one of those
  // ticks, only a real change in connection state -- so the role="status"
  // region's accessible name (an explicit aria-label, not the ticking text
  // content) has to stay put across ticks.
  describe("accessible name stability", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps the announced name unchanged across ticks that only advance the quiet-feed seconds", () => {
      vi.useFakeTimers();
      const start = Date.now();
      resetStore({
        connection: "open",
        lastMessageAt: start - 6_000,
        displayed: displayedWithSession({ status: "live" }),
      });
      render(<ConnectionPill />);

      const status = screen.getByRole("status");
      const nameBefore = status.getAttribute("aria-label");
      expect(nameBefore).toBe("Live · quiet feed");

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // The visible seconds count keeps advancing, but the announced name does not.
      expect(screen.getByText(/Live · last update \d+s ago/)).toBeInTheDocument();
      expect(status.getAttribute("aria-label")).toBe(nameBefore);
    });

    it("changes the announced name as the connection moves from connecting to open to reconnecting", () => {
      resetStore({ connection: "connecting", displayed: displayedWithSession({ status: "live" }) });
      const { rerender } = render(<ConnectionPill />);
      const connecting = screen.getByRole("status").getAttribute("aria-label");

      resetStore({ connection: "open", lastMessageAt: Date.now(), displayed: displayedWithSession({ status: "live" }) });
      rerender(<ConnectionPill />);
      const open = screen.getByRole("status").getAttribute("aria-label");

      resetStore({ connection: "reconnecting", displayed: displayedWithSession({ status: "live" }) });
      rerender(<ConnectionPill />);
      const reconnecting = screen.getByRole("status").getAttribute("aria-label");

      expect(connecting).not.toBe(open);
      expect(open).not.toBe(reconnecting);
      expect(connecting).not.toBe(reconnecting);
    });
  });
});
