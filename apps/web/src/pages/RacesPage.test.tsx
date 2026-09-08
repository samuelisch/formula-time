import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";

import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import type { LivePush } from "../live/types.ts";
import type { RaceIndexEntry } from "../races/api.ts";
import { RacesPage } from "./RacesPage.tsx";

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

function stubFetch(races: RaceIndexEntry[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(races), { status: 200 })),
  );
}

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/", element: <RacesPage /> }]);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const races: RaceIndexEntry[] = [
  {
    session_key: 11361,
    name: "Race",
    country: "Italy",
    date_start: "2026-09-06T13:00:00.000Z",
    date_end: "2026-09-06T15:00:00.000Z",
    total_laps: 53,
    exported_at: "2026-09-06T15:10:00.000Z",
  },
  {
    session_key: 11200,
    name: "Race",
    country: "Netherlands",
    date_start: "2026-08-30T13:00:00.000Z",
    date_end: "2026-08-30T15:00:00.000Z",
    total_laps: 72,
    exported_at: "2026-08-30T15:10:00.000Z",
  },
];

describe("RacesPage", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the quiet line when there is no live session", async () => {
    stubFetch([]);
    renderPage();
    expect(screen.getByText("No live session right now")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("No past races yet")).toBeInTheDocument());
  });

  it("shows a Live now card linking to /live when the session status is live", async () => {
    resetStore({
      displayed: displayedWithSession({ status: "live", country: "Italy", name: "Race", date_start: "2026-09-08T13:00:00.000Z" }),
    });
    stubFetch([]);
    renderPage();

    expect(screen.getByText("Live now")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Live now/ });
    expect(link).toHaveAttribute("href", "/live");
  });

  it("shows a neutral Next race card linking to /live when the session status is upcoming", async () => {
    resetStore({
      displayed: displayedWithSession({ status: "upcoming", country: "Italy", name: "Race", date_start: "2026-09-08T13:00:00.000Z" }),
    });
    stubFetch([]);
    renderPage();

    expect(screen.getByText("Next race · Italy · Race · 2026-09-08")).toBeInTheDocument();
    expect(screen.queryByText("Live now")).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Next race/ });
    expect(link).toHaveAttribute("href", "/live");
  });

  it("shows the quiet line when the session status is finished", async () => {
    resetStore({
      displayed: displayedWithSession({ status: "finished", country: "Italy", name: "Race", date_start: "2026-09-08T13:00:00.000Z" }),
    });
    stubFetch([]);
    renderPage();

    expect(screen.getByText("No live session right now")).toBeInTheDocument();
    expect(screen.queryByText("Live now")).not.toBeInTheDocument();
  });

  it("renders rows from the stubbed /api/races fetch, newest first as served", async () => {
    stubFetch(races);
    renderPage();

    await waitFor(() => expect(screen.getByText("Italy · Race")).toBeInTheDocument());
    expect(screen.getByText("Netherlands · Race")).toBeInTheDocument();

    const italyLink = screen.getByRole("link", { name: /Italy · Race/ });
    expect(italyLink).toHaveAttribute("href", "/races/11361");
    expect(screen.getByText("2026-09-06 · 53 laps")).toBeInTheDocument();
  });
});
