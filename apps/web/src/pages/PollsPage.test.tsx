// PollsPage: race selection (URL-driven, RaceSelect), the current session's
// polls from the push (or the pre-push initial fill, issue #51's fallback),
// a stubbed fetch for any other race, both empty states, and the live lap
// line. Also carries the fix-round-3 regression for issue #51: a vote cast
// during the initial-fill window (GET /api/polls, before the first SSE push
// -- the session key is not yet known) must still show as "your pick" once
// the first push lands and the page switches to rendering the displayed
// push's polls. votes.ts keys by poll_id alone (poll ids already embed the
// session key server-side), so this holds regardless of what, if anything,
// changes about the session between the two renders.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import { makePoll } from "../polls/pollFixtures.ts";
import type { RaceIndexEntry } from "../races/api.ts";
import { makePush } from "../test/fixtures.ts";
import { NO_SESSION_TIMEOUT_MS, PollsPage } from "./PollsPage.tsx";

function resetStore(overrides: Partial<ReturnType<typeof useLiveStore.getState>> = {}): void {
  useLiveStore.setState({
    connection: "connecting",
    catchingUp: false,
    statusReceived: false,
    lastMessageAt: null,
    live: null,
    buffer: emptyBuffer(),
    delayMs: 0,
    displayed: null,
    bufferShort: false,
    ...overrides,
  });
}

/** Settled: the SSE connection is open and has delivered a status frame, but (per the test) not necessarily a push yet -- the state fix round 2 on PR #85 needs before it will show anything but "Connecting…". */
function settledConnection(): Partial<ReturnType<typeof useLiveStore.getState>> {
  return { connection: "open", statusReceived: true };
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

interface FetchHandlers {
  polls?: unknown;
  races?: RaceIndexEntry[];
  racePolls?: Record<string, unknown>;
  vote?: unknown;
}

function stubFetch(handlers: FetchHandlers): ReturnType<typeof vi.fn> {
  const fn = vi.fn((url: string) => {
    if (url === "/api/polls") return Promise.resolve(new Response(JSON.stringify(handlers.polls ?? []), { status: 200 }));
    if (url === "/api/races") return Promise.resolve(new Response(JSON.stringify(handlers.races ?? []), { status: 200 }));
    if (url === "/api/vote") return Promise.resolve(new Response(JSON.stringify(handlers.vote ?? {}), { status: 200 }));
    const racePollsMatch = /^\/api\/races\/([^/]+)\/polls$/.exec(url);
    if (racePollsMatch) {
      const key = racePollsMatch[1] as string;
      return Promise.resolve(new Response(JSON.stringify(handlers.racePolls?.[key] ?? []), { status: 200 }));
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function renderPage(initialPath = "/polls") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/polls", element: <PollsPage /> }], { initialEntries: [initialPath] });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("PollsPage", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetStore();
  });

  it("shows the current session's polls from the displayed push by default", async () => {
    const poll = makePoll({ poll_id: "9999:winner", status: "open", question: "Who wins the race?" });
    resetStore({
      displayed: makePush(
        { session_key: "9999", polls: [poll] },
        { session: { session_key: "9999", country: "Italy", name: "Race", status: "finished" } },
      ),
    });
    stubFetch({ races: [] });

    renderPage();

    expect(await screen.findByText("Who wins the race?")).toBeInTheDocument();
  });

  it("keeps a vote cast before the first push visible once the push lands", async () => {
    const poll = makePoll({ poll_id: "99911353:winner", status: "open" });
    // Connected and settled, but the session hasn't pushed its first state
    // yet -- past "Connecting…", into the GET /api/polls initial-fill window.
    resetStore(settledConnection());

    stubFetch({
      polls: [poll],
      races: [],
      vote: { poll_id: "99911353:winner", option_id: "opt-a", viewer_id: "v1", counted: true },
    });

    renderPage();

    // Initial fill: GET /api/polls, no push has arrived yet (displayed === null).
    const optionButton = await screen.findByRole("button", { name: /Verstappen/ });
    fireEvent.click(optionButton);

    await waitFor(() => expect(screen.getByText(/your pick/)).toBeInTheDocument());

    // The first push lands: the page now renders from the displayed push
    // instead of the initial fetch.
    act(() => {
      useLiveStore.setState({
        displayed: makePush(
          { session_key: "99911353", polls: [poll] },
          { session: { session_key: "99911353", country: "Italy", name: "Race", status: "finished" } },
        ),
      });
    });

    expect(screen.getByText(/your pick/)).toBeInTheDocument();
  });

  it("shows a historical race's polls, fetched by session_key, when selected via the URL", async () => {
    resetStore({
      displayed: makePush(
        { session_key: "9999", polls: [] },
        { session: { session_key: "9999", country: "Italy", name: "Race", status: "finished" } },
      ),
    });
    const historicalPoll = makePoll({ poll_id: "11361:podium", question: "Podium order?" });
    stubFetch({ races, racePolls: { "11361": [historicalPoll] } });

    renderPage("/polls?race=11361");

    expect(await screen.findByText("Podium order?")).toBeInTheDocument();
  });

  it("shows No polls for this race when the selected race has none", async () => {
    resetStore({
      displayed: makePush(
        { session_key: "9999", polls: [] },
        { session: { session_key: "9999", country: "Italy", name: "Race", status: "finished" } },
      ),
    });
    stubFetch({ races, racePolls: { "11200": [] } });

    renderPage("/polls?race=11200");

    expect(await screen.findByText("No polls for this race")).toBeInTheDocument();
  });

  it("shows the empty state and the PRD Friday-open line when the selected (current) race is upcoming with no polls", async () => {
    resetStore({
      displayed: makePush(
        { session_key: "9999", polls: [] },
        { session: { session_key: "9999", country: "Italy", name: "Race", status: "upcoming" } },
      ),
    });
    stubFetch({ races: [] });

    renderPage();

    expect(await screen.findByText("No polls for this race")).toBeInTheDocument();
    expect(screen.getByText("Polls open on the Friday of the race weekend once the entry list is known")).toBeInTheDocument();
  });

  it("shows the LAP line above the list only when the selected race is the current session and it is live", async () => {
    resetStore({
      displayed: makePush({ session_key: "9999", total_laps: 53 }, { session: { session_key: "9999", country: "Italy", name: "Race", status: "live" } }),
    });
    stubFetch({ races: [] });

    renderPage();

    expect(await screen.findByText("LAP 12/53")).toBeInTheDocument();
  });

  it("hides the LAP line when the current session is not live", async () => {
    resetStore({
      displayed: makePush(
        { session_key: "9999", total_laps: 53 },
        { session: { session_key: "9999", country: "Italy", name: "Race", status: "finished" } },
      ),
    });
    stubFetch({ races: [] });

    renderPage();

    await screen.findByText("No polls for this race");
    expect(screen.queryByText(/^LAP /)).not.toBeInTheDocument();
  });

  it("hides the LAP line when a historical (non-current) race is selected, even while the current session is live", async () => {
    resetStore({
      displayed: makePush({ session_key: "9999", total_laps: 53 }, { session: { session_key: "9999", country: "Italy", name: "Race", status: "live" } }),
    });
    stubFetch({ races, racePolls: { "11361": [] } });

    renderPage("/polls?race=11361");

    await screen.findByText("No polls for this race");
    expect(screen.queryByText(/^LAP /)).not.toBeInTheDocument();
  });

  // Fix round 2 on PR #85: the previous (round 1) fix inferred "no current
  // session" straight from `sessionKey === null`, which raced GET /api/races
  // against the first SSE push -- a fast-resolving races fetch could show an
  // unrelated race's polls moments before the real push landed. These four
  // cases pin the settled-connection design that replaced it.
  describe("default selection when no current session is known yet (fix round 2)", () => {
    it("shows Connecting… while settling, even once GET /api/races has already resolved", async () => {
      resetStore(); // connection: "connecting" (default) -- never settles in this test.
      stubFetch({ races });

      renderPage();

      expect(await screen.findByText("Connecting…")).toBeInTheDocument();
      expect(screen.queryByText("No polls for this race")).not.toBeInTheDocument();
    });

    it("leaves Connecting… for the normal current-session view once settled, then shows the push's polls once it lands", async () => {
      resetStore(); // still "connecting"
      const poll = makePoll({ poll_id: "9999:winner", question: "Who wins?" });
      stubFetch({ polls: [], races: [] });

      renderPage();
      expect(await screen.findByText("Connecting…")).toBeInTheDocument();

      // Settles (connection open, a status frame lands) -- still no push,
      // but settling itself is over: falls through to the ordinary
      // current-session view (the GET /api/polls initial fill, which
      // resolved to [] here), not "Connecting…" any more.
      act(() => {
        useLiveStore.setState(settledConnection());
      });
      await waitFor(() => expect(screen.queryByText("Connecting…")).not.toBeInTheDocument());
      expect(await screen.findByText("No polls for this race")).toBeInTheDocument();

      act(() => {
        useLiveStore.setState({
          displayed: makePush({ session_key: "9999", polls: [poll] }, { session: { session_key: "9999", country: "Italy", name: "Race", status: "live" } }),
        });
      });
      expect(await screen.findByText("Who wins?")).toBeInTheDocument();
    });

    it(`falls back to the newest race's own polls once settled and NO_SESSION_TIMEOUT_MS pass with still no push`, async () => {
      resetStore(settledConnection()); // open + a status frame already landed, no push
      const historicalPoll = makePoll({ poll_id: "11361:winner", question: "Podium order?" });
      stubFetch({ polls: [], races, racePolls: { "11361": [historicalPoll] } });

      vi.useFakeTimers();
      try {
        renderPage();
        // Settled from the start (settledConnection()) -- no "Connecting…",
        // straight to the normal (empty, so far) current-session view while
        // the background timeout runs.
        expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(NO_SESSION_TIMEOUT_MS);
        });
        // Flush whatever the resulting state change queued (TanStack
        // Query's own scheduling) before real timers take back over.
        await act(async () => {
          await vi.runOnlyPendingTimersAsync();
        });
      } finally {
        vi.useRealTimers();
      }

      expect(await screen.findByText("Podium order?")).toBeInTheDocument();
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("11361");
    });

    it("an explicit ?race= param wins immediately, ignoring settling", async () => {
      resetStore(); // connection stays "connecting" throughout -- never settles
      const historicalPoll = makePoll({ poll_id: "11361:winner", question: "Podium order?" });
      stubFetch({ races, racePolls: { "11361": [historicalPoll] } });

      renderPage("/polls?race=11361");

      expect(await screen.findByText("Podium order?")).toBeInTheDocument();
      expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
    });
  });
});
