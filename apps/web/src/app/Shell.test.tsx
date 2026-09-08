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

// CSS Modules hash class names (e.g. `_live_ab12c`); match on the tone
// fragment rather than an exact class so this survives a hash change.
function pillToneOf(text: string | RegExp): "neutral" | "live" | "warn" {
  const pill = screen.getByText(text);
  if (/_live_/.test(pill.className)) return "live";
  if (/_warn_/.test(pill.className)) return "warn";
  return "neutral";
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

  it("shows Live · connected once open with no catch-up, a recent message, and a live session", () => {
    resetStore({ connection: "open", lastMessageAt: Date.now(), displayed: displayedWithSession({ status: "live" }) });
    renderShell();
    expect(screen.getByText("Live · connected")).toBeInTheDocument();
  });

  it("shows Live · catching up while the fanout is replaying a live session", () => {
    resetStore({
      connection: "open",
      catchingUp: true,
      lastMessageAt: Date.now(),
      displayed: displayedWithSession({ status: "live" }),
    });
    renderShell();
    expect(screen.getByText("Live · catching up")).toBeInTheDocument();
  });

  it("shows Live · reconnecting… when the connection drops mid live session", () => {
    resetStore({ connection: "reconnecting", displayed: displayedWithSession({ status: "live" }) });
    renderShell();
    expect(screen.getByText("Live · reconnecting…")).toBeInTheDocument();
    expect(pillToneOf("Live · reconnecting…")).toBe("warn");
  });

  it("shows a quiet-feed pill once a live feed has been silent for 5s or more", () => {
    resetStore({
      connection: "open",
      lastMessageAt: Date.now() - 6_000,
      displayed: displayedWithSession({ status: "live" }),
    });
    renderShell();
    expect(screen.getByText(/Live · last update \d+s ago/)).toBeInTheDocument();
  });

  it('drops the "Live" word to "Connected" once open with no live session, keeping the live (green) tone', () => {
    resetStore({ connection: "open", lastMessageAt: Date.now() });
    renderShell();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(pillToneOf("Connected")).toBe("live");
  });

  it("shows Connected · catching up, still green, when the fanout replays a finished session", () => {
    resetStore({
      connection: "open",
      catchingUp: true,
      lastMessageAt: Date.now(),
      displayed: displayedWithSession({ status: "finished" }),
    });
    renderShell();
    expect(screen.getByText("Connected · catching up")).toBeInTheDocument();
    expect(pillToneOf("Connected · catching up")).toBe("live");
  });

  it("shows Connected · reconnecting…, still amber/warn, when the connection drops with no live session", () => {
    resetStore({ connection: "reconnecting", displayed: displayedWithSession({ status: "upcoming" }) });
    renderShell();
    expect(screen.getByText("Connected · reconnecting…")).toBeInTheDocument();
    expect(pillToneOf("Connected · reconnecting…")).toBe("warn");
  });

  it("shows Connected · last update Ns ago, still green, once a finished session's feed has been silent for 5s or more", () => {
    resetStore({
      connection: "open",
      lastMessageAt: Date.now() - 6_000,
      displayed: displayedWithSession({ status: "finished" }),
    });
    renderShell();
    expect(screen.getByText(/Connected · last update \d+s ago/)).toBeInTheDocument();
    expect(pillToneOf(/Connected · last update \d+s ago/)).toBe("live");
  });

  it("renders the session line from the projector's real fields (country, name)", () => {
    // apps/api/src/projector/projector.ts sessionAsRawRecord() puts
    // `country` and `name` (the session name, e.g. "Race") on the wire --
    // never `country_name`/`circuit_short_name`, which the wire has no field for.
    resetStore({
      connection: "open",
      lastMessageAt: Date.now(),
      displayed: displayedWithSession({ status: "live", name: "Race", country: "Italy", circuit_key: 39 }),
    });
    renderShell();
    expect(screen.getByText("Italy · Race")).toBeInTheDocument();
  });

  it("suffixes the session line with · finished when the session has finished", () => {
    resetStore({
      connection: "open",
      lastMessageAt: Date.now(),
      displayed: displayedWithSession({ status: "finished", name: "Race", country: "Italy" }),
    });
    renderShell();
    expect(screen.getByText("Italy · Race · finished")).toBeInTheDocument();
  });

  it("suffixes the session line with · upcoming when the session has not started", () => {
    resetStore({
      connection: "open",
      lastMessageAt: Date.now(),
      displayed: displayedWithSession({ status: "upcoming", name: "Race", country: "Italy" }),
    });
    renderShell();
    expect(screen.getByText("Italy · Race · upcoming")).toBeInTheDocument();
  });

  it("shows waiting-for-a-session when the session record is missing a field", () => {
    resetStore({
      connection: "open",
      lastMessageAt: Date.now(),
      displayed: displayedWithSession({ status: "live", country: "Italy" }),
    });
    renderShell();
    expect(screen.getByText("Waiting for a session")).toBeInTheDocument();
  });
});
