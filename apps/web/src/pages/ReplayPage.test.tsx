import type { RaceEvent, RawRecord } from "@formula-time/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";

import { useLiveStore } from "../live/store.ts";
import { makePoll } from "../polls/pollFixtures.ts";
import { usePollModalUiStore } from "../polls/pollModalStore.ts";
import type { RaceFile, RaceIndexEntry } from "../races/api.ts";
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

/** The index entry for the fixture session; defaults line up with `RACE_FILE` so a plain `stubFetch()` serves a self-consistent index + file pair. */
function makeIndexEntry(overrides: Partial<RaceIndexEntry> = {}): RaceIndexEntry {
  return {
    session_key: 11361,
    name: "Race",
    country: "Italy",
    date_start: "2026-09-06T13:00:00.000Z",
    date_end: "2026-09-06T15:00:00.000Z",
    total_laps: 2,
    exported_at: RACE_FILE.exported_at,
    ...overrides,
  };
}

/** Routes a fetch mock's calls to the index or the file response by URL, the same way the real api does. */
function routeFetch(file: RaceFile, index: RaceIndexEntry[]) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === "/api/races") {
      return new Response(JSON.stringify(index), { status: 200 });
    }
    if (url.startsWith("/api/races/")) {
      return new Response(JSON.stringify(file), { status: 200 });
    }
    throw new Error(`ReplayPage test: unexpected fetch ${url}`);
  };
}

function stubFetch(
  file: RaceFile = RACE_FILE,
  index: RaceIndexEntry[] = [makeIndexEntry({ exported_at: file.exported_at })],
) {
  const fetchMock = vi.fn(routeFetch(file, index));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage(queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })): QueryClient {
  const router = createMemoryRouter([{ path: "/races/:session_key", element: <ReplayPage /> }], {
    initialEntries: ["/races/11361"],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return queryClient;
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

  it("requests the file with a version query built from the index entry's exported_at", async () => {
    const fetchMock = stubFetch();
    renderPage();

    await waitFor(() => screen.getByRole("slider", { name: "Playback position" }));

    const fileUrl = fetchMock.mock.calls.map(([url]) => String(url)).find((url) => url.startsWith("/api/races/11361"));
    expect(fileUrl).toBe(`/api/races/11361?v=${Date.parse(RACE_FILE.exported_at)}`);
  });

  it("requests a new file when the index's exported_at changes", async () => {
    const fetchMock = stubFetch();
    const queryClient = renderPage();

    await waitFor(() => screen.getByRole("slider", { name: "Playback position" }));
    const firstVersion = `?v=${Date.parse(RACE_FILE.exported_at)}`;
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(firstVersion))).toBe(true);

    const reExportedAt = "2026-09-07T00:00:00.000Z";
    fetchMock.mockImplementation(routeFetch(RACE_FILE, [makeIndexEntry({ exported_at: reExportedAt })]));
    await queryClient.refetchQueries({ queryKey: ["races"] });

    const secondVersion = `?v=${Date.parse(reExportedAt)}`;
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes(secondVersion))).toBe(true);
    });
  });

  it("shows the error card and never requests the file when the session is missing from the index", async () => {
    const fetchMock = stubFetch(RACE_FILE, []);
    renderPage();

    await waitFor(() => expect(screen.getByText("Could not load this race.")).toBeInTheDocument());

    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/races/11361"))).toBe(false);
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
  // independent guards: the replay mounts the pure `Board`, so no polls UI
  // is mounted at all, and `usePolls()`/`PollModal` read the push through
  // `useBoardPush()` rather than the live store, so even mounted they would
  // see `polls: []` (pinned directly by polls/usePolls.test.tsx).
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

  // A replay mounts the pure `Board`, never `BoardPage`. The live route's
  // furniture all reads the live session or the live store, and on a
  // replay every piece of it is wrong: the finished banner always fires
  // (the exporter only exports finished sessions) and would link the
  // replay back to itself, and the delay control acted on a push buffer
  // the replay does not use. `AlignPanel` is the one live-only piece that
  // mounts on both routes -- see the dedicated test below.
  it("mounts none of the live route's session furniture: no banner, no polls button, no Live button", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => screen.getByRole("slider", { name: "Playback position" }));

    // The fixture session's status is "finished" -- the banner would fire here.
    expect(screen.queryByText(/This race has finished/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Watch the replay" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Race starts/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Polls/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Live" })).not.toBeInTheDocument(); // DelayControl/TransportBar's live-only button
  });

  // Alignment on a replay drives the same `useAligner`, routed through
  // `useTimeTarget()` instead of the live store directly, so the align
  // button mounts in the replay toolbar next to the transport bar.
  it("mounts the align button in the toolbar, next to the transport bar", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => screen.getByRole("slider", { name: "Playback position" }));

    expect(screen.getByRole("button", { name: /Align with my screen/ })).toBeInTheDocument();
  });
});

describe("ReplayPage -- start notice", () => {
  beforeEach(resetStores);

  afterEach(() => {
    vi.unstubAllGlobals();
    resetStores();
  });

  // The recording in this fixture starts 54 minutes before the leader
  // reaches lap 1 -- a position event with no lap yet, then the lap-1 event
  // 54 minutes later -- matching how a real recording opens well before
  // lights-out.
  const GAP_MINUTES = 54;
  const RACE_FILE_WITH_GAP: RaceFile = {
    schema: 1,
    exported_at: "2026-09-06T15:10:00.000Z",
    session: { ...SESSION, total_laps: 1 },
    events: [
      event("g1", "position", 0, { driver_number: 1, position: 1 }),
      event("g2", "laps", GAP_MINUTES * 60, { driver_number: 1, lap_number: 1 }),
    ],
  };
  const RACE_FILE_NO_LAP_ONE: RaceFile = {
    schema: 1,
    exported_at: "2026-09-06T15:10:00.000Z",
    session: { ...SESSION, total_laps: 1 },
    events: [event("p1", "position", 0, { driver_number: 1, position: 1 })],
  };

  it('shows "This replay starts 54 min before lights out" while the displayed position is before lights-out', async () => {
    stubFetch(RACE_FILE_WITH_GAP);
    renderPage();

    await waitFor(() => screen.getByRole("slider", { name: "Playback position" }));

    expect(screen.getByText(/This replay starts 54 min before lights out\./)).toBeInTheDocument();
  });

  it("clicking the notice's link jumps to the lights-out anchor and hides the notice", async () => {
    const user = userEvent.setup();
    stubFetch(RACE_FILE_WITH_GAP);
    renderPage();

    const slider = (await waitFor(() =>
      screen.getByRole("slider", { name: "Playback position" }),
    )) as HTMLInputElement;
    const lightsOutMs = Date.parse(isoAt(GAP_MINUTES * 60));

    await user.click(screen.getByRole("button", { name: "Jump to race start" }));

    expect(slider.value).toBe(String(lightsOutMs));
    expect(screen.queryByText(/This replay starts/)).not.toBeInTheDocument();
  });

  it("shows no notice when the fold has no lap-1 anchor", async () => {
    stubFetch(RACE_FILE_NO_LAP_ONE);
    renderPage();

    await waitFor(() => screen.getByRole("slider", { name: "Playback position" }));

    expect(screen.queryByText(/This replay starts/)).not.toBeInTheDocument();
  });
});
