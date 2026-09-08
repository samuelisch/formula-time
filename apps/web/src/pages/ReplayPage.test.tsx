import type { RaceEvent, RawRecord } from "@formula-time/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";

import { useLiveStore } from "../live/store.ts";
import { makePoll } from "../polls/pollFixtures.ts";
import { usePollModalUiStore } from "../polls/pollModalStore.ts";
import type { RaceFile } from "../races/api.ts";
import { makePush } from "../test/fixtures.ts";
import { ReplayPage } from "./ReplayPage.tsx";

const SESSION: RawRecord = {
  session_key: 11361,
  name: "Race",
  country: "Italy",
  circuit_key: 39,
  date_start: "2026-09-06T13:00:00.000Z",
  date_end: "2026-09-06T15:00:00.000Z",
  total_laps: 2,
  status: "finished",
};

function isoAt(offsetSeconds: number): string {
  return new Date(Date.parse("2026-09-06T13:00:00.000Z") + offsetSeconds * 1000).toISOString();
}

function event(id: string, endpoint: string, offsetSeconds: number, payload: RawRecord): RaceEvent {
  return { event_id: id, endpoint, source_time: isoAt(offsetSeconds), payload };
}

const EVENTS: RaceEvent[] = [
  event("e1", "position", 0, { driver_number: 1, position: 1 }),
  event("e2", "laps", 0, { driver_number: 1, lap_number: 1 }),
  event("e3", "laps", 30, { driver_number: 1, lap_number: 2 }),
];

const RACE_FILE: RaceFile = {
  schema: 1,
  exported_at: "2026-09-06T15:10:00.000Z",
  session: SESSION,
  events: EVENTS,
};

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(RACE_FILE), { status: 200 })),
  );
}

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/races/:session_key", element: <ReplayPage /> }], {
    initialEntries: ["/races/11361"],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function resetStores(): void {
  useLiveStore.setState({ displayed: null });
  usePollModalUiStore.setState({ isOpen: false, lastSignature: "", lastSessionKey: null });
}

describe("ReplayPage", () => {
  beforeEach(resetStores);

  afterEach(() => {
    vi.unstubAllGlobals();
    resetStores();
  });

  it("fetches the export file, folds it, and mounts the board through BoardSourceProvider with the transport bar's slider bounds", async () => {
    stubFetch();
    renderPage();

    expect(screen.getByText("Loading race…")).toBeInTheDocument();

    const slider = await waitFor(() => screen.getByRole("slider", { name: "Playback position" }));
    expect(slider).toHaveAttribute("min", String(Date.parse(isoAt(0))));
    expect(slider).toHaveAttribute("max", String(Date.parse(isoAt(30))));

    // The board itself mounted, showing the state at the playback position
    // (the race start, where the fold has applied e1/e2 but not yet e3).
    expect(screen.getByText("LAP 1/2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Race start" })).toBeInTheDocument();
  });

  it("shows an error state when the file fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText("Could not load this race.")).toBeInTheDocument());
  });

  // Polls are live-only by product stance: a replay must never show or open
  // them. `Shell` holds the live SSE connection open on every route, so the
  // live store can hold an open poll while a replay is mounted. Two
  // independent guards, both fixed on this branch: the replay mounts the
  // pure `Board`, so no polls UI is mounted at all (round 5), and
  // `usePolls()`/`PollModal` read the push through `useBoardPush()` rather
  // than the live store, so even mounted they would see `polls: []` (round
  // 4, pinned directly by polls/usePolls.test.tsx).
  it("shows no polls UI and never pops the modal while the live store holds an open poll", async () => {
    useLiveStore.setState({
      displayed: makePush({ session_key: "9999", polls: [makePoll({ poll_id: "9999:winner", status: "open" })] }),
    });
    stubFetch();
    renderPage();

    await waitFor(() => screen.getByRole("slider", { name: "Playback position" }));

    expect(screen.queryByRole("button", { name: /^Polls/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Race polls" })).not.toBeInTheDocument();
  });

  // Round 5: a replay mounts the pure `Board`, never `BoardPage`. The live
  // route's furniture all reads the live session or the live store, and on a
  // replay every piece of it is wrong: the finished banner always fires (the
  // exporter only exports finished sessions) and would link the replay back
  // to itself, and the delay/align controls act on a push buffer the replay
  // does not use.
  it("mounts none of the live route's furniture: no banner, no polls button, no delay or align control", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => screen.getByRole("slider", { name: "Playback position" }));

    // The fixture session's status is "finished" -- the banner would fire here.
    expect(screen.queryByText(/This race has finished/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Watch the replay" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Race starts/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Polls/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Live" })).not.toBeInTheDocument(); // DelayControl
    expect(screen.queryByRole("button", { name: /Align with my screen/ })).not.toBeInTheDocument();
  });
});
