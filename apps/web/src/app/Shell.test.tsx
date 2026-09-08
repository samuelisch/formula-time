import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";

import { FakeEventSource } from "../test/fakeEventSource.ts";
import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import type { LivePush } from "../live/types.ts";
import { Shell } from "./Shell.tsx";

// jsdom has no EventSource; Shell mounts useLiveStream() itself, so stub the
// global constructor rather than exercising the real stream in these tests.
globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

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

function renderShell(): void {
  const router = createMemoryRouter([{ path: "/", element: <Shell />, children: [{ index: true, element: <div /> }] }]);
  render(<RouterProvider router={router} />);
}

describe("Shell", () => {
  beforeEach(() => {
    resetStore();
  });

  it("shows the connecting pill and waiting-for-a-session line by default", () => {
    renderShell();
    expect(screen.getByText("connecting…")).toBeInTheDocument();
    expect(screen.getByText("Waiting for a session")).toBeInTheDocument();
  });

  it("shows Live · connected once open with no catch-up and a recent message", () => {
    resetStore({ connection: "open", lastMessageAt: Date.now() });
    renderShell();
    expect(screen.getByText("Live · connected")).toBeInTheDocument();
  });

  it("shows Live · catching up while the fanout is replaying", () => {
    resetStore({ connection: "open", catchingUp: true, lastMessageAt: Date.now() });
    renderShell();
    expect(screen.getByText("Live · catching up")).toBeInTheDocument();
  });

  it("shows Live · reconnecting… when the connection drops", () => {
    resetStore({ connection: "reconnecting" });
    renderShell();
    expect(screen.getByText("Live · reconnecting…")).toBeInTheDocument();
  });

  it("shows a quiet-feed pill once the feed has been silent for 5s or more", () => {
    resetStore({ connection: "open", lastMessageAt: Date.now() - 6_000 });
    renderShell();
    expect(screen.getByText(/Live · last update \d+s ago/)).toBeInTheDocument();
  });

  it("renders the session line from country_name and circuit_short_name once a session arrives", () => {
    resetStore({
      connection: "open",
      lastMessageAt: Date.now(),
      displayed: displayedWithSession({ country_name: "Netherlands", circuit_short_name: "Zandvoort" }),
    });
    renderShell();
    expect(screen.getByText("Netherlands · Zandvoort")).toBeInTheDocument();
  });

  it("falls back to the projector's actual session shape (country, no circuit name)", () => {
    // apps/api/src/projector/projector.ts sessionAsRawRecord() puts `country`
    // on the wire, not `country_name`, and no circuit display name at all.
    resetStore({
      connection: "open",
      lastMessageAt: Date.now(),
      displayed: displayedWithSession({ name: "Race", country: "Italy", circuit_key: 39 }),
    });
    renderShell();
    expect(screen.getByText("Italy")).toBeInTheDocument();
  });
});
