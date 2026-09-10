import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";

import { FakeEventSource } from "../test/fakeEventSource.ts";
import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import type { LivePush } from "../live/types.ts";
import { useHeaderStore } from "./headerStore.ts";
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
    useHeaderStore.setState({ override: null });
  });

  it("shows the waiting-for-a-session line by default", () => {
    renderShell();
    expect(screen.getByText("Waiting for a session")).toBeInTheDocument();
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

  // DelayControl and AlignPanel mount in BoardPage's toolbar, the live
  // route only; the shell itself carries no alignment controls.
  it("mounts no alignment controls of its own -- they belong to the live board", () => {
    resetStore({ connection: "open", lastMessageAt: Date.now(), displayed: displayedWithSession({ status: "live" }) });
    renderShell();
    expect(screen.queryByRole("button", { name: "Live" })).not.toBeInTheDocument(); // DelayControl's back-to-live
    expect(screen.queryByRole("button", { name: /Align with my screen/ })).not.toBeInTheDocument();
    // The "Live" nav link still renders -- it is a link, not a control.
    expect(screen.getByRole("link", { name: "Live" })).toBeInTheDocument();
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

  it("shows the header override line instead of the live session line when set", () => {
    resetStore({
      connection: "open",
      lastMessageAt: Date.now(),
      displayed: displayedWithSession({ status: "live", name: "Race", country: "Italy" }),
    });
    useHeaderStore.setState({ override: { line: "Netherlands · Race · replay" } });
    renderShell();
    expect(screen.getByText("Netherlands · Race · replay")).toBeInTheDocument();
    expect(screen.queryByText("Italy · Race")).not.toBeInTheDocument();
  });

  it("falls back to the live session line once the override is cleared", () => {
    resetStore({
      connection: "open",
      lastMessageAt: Date.now(),
      displayed: displayedWithSession({ status: "live", name: "Race", country: "Italy" }),
    });
    useHeaderStore.setState({ override: { line: "Netherlands · Race · replay" } });
    useHeaderStore.setState({ override: null });
    renderShell();
    expect(screen.getByText("Italy · Race")).toBeInTheDocument();
  });

  // The connection pill lives on the live page only (ConnectionPill.tsx,
  // mounted by BoardPage): the shell itself is not a live-session view, so
  // it never shows connection wording on any route.
  it("shows no connection pill in the header, on any route or session status", () => {
    resetStore({ connection: "open", lastMessageAt: Date.now(), displayed: displayedWithSession({ status: "live" }) });
    renderShell();
    expect(screen.queryByText(/connected|connecting|catching up|reconnecting|last update/i)).not.toBeInTheDocument();
  });
});
