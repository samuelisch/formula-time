// The `/live` route = the pure `Board` (covered by board/Board.test.tsx)
// plus the live-only furniture: the finished/upcoming banner, polls, and
// the delay/align controls. These tests cover that furniture and the fact
// that it is mounted here, not in the shell and not on a replay.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";

import { BoardSourceProvider } from "../board/useBoardState.ts";
import { emptyAnchors } from "../live/anchors.ts";
import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import { appendEvents, createTimeline } from "../replay/timeline.ts";
import { makeDriver, makePush } from "../test/fixtures.ts";
import { BoardPage } from "./BoardPage.tsx";

// A no-signal race control block: neither field the racing gate reads is set.
const NOT_RACING_CONTROL = {
  session_status: null,
  current_flag: null,
  safety_car: null,
  active_flags: {},
  driver_flags: {},
  recent_messages: [],
};

// The loader itself is covered by its own test
// (`live/LiveTimelineLoader.test.tsx`); here it is a spy so BoardPage.test's
// mount-latch assertions don't also need to fake `../races/api.ts`'s
// `fetchRaceEventsPage`.
vi.mock("../live/LiveTimelineLoader.tsx", () => ({
  LiveTimelineLoader: vi.fn(() => null),
}));
import { LiveTimelineLoader } from "../live/LiveTimelineLoader.tsx";

function resetLiveStore(overrides: Partial<ReturnType<typeof useLiveStore.getState>> = {}): void {
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

// Defaults to no racing signal beyond `status` itself (empty race control,
// no drivers); pass `stateOverrides` to add `race_control`/`drivers` signals
// for a test that needs the fold, not just the row, to say racing has begun.
function liveSessionPush(
  status: "upcoming" | "live" | "finished",
  stateOverrides: Partial<Parameters<typeof makePush>[1]> = {},
): ReturnType<typeof makePush> {
  return makePush(
    {},
    {
      session: { session_key: "9999", name: "Race", country: "Italy", status },
      race_control: NOT_RACING_CONTROL,
      drivers: {},
      driver_order: [],
      ...stateOverrides,
    },
  );
}

function renderWith(push: ReturnType<typeof makePush> | null): void {
  render(
    <MemoryRouter>
      <BoardSourceProvider push={push}>
        <BoardPage />
      </BoardSourceProvider>
    </MemoryRouter>,
  );
}

// A real router (not a bare MemoryRouter) so the test can read back
// `?driver=` from `router.state.location.search` after a click.
function renderWithRouter(push: ReturnType<typeof makePush> | null) {
  const router = createMemoryRouter(
    [
      {
        path: "/live",
        element: (
          <BoardSourceProvider push={push}>
            <BoardPage />
          </BoardSourceProvider>
        ),
      },
    ],
    { initialEntries: ["/live"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("BoardPage", () => {
  beforeEach(() => {
    resetLiveStore();
    vi.mocked(LiveTimelineLoader).mockClear();
  });

  it("mounts the board itself", () => {
    renderWith(makePush());

    expect(screen.getByText("LAP 12/53")).toBeInTheDocument();
    expect(screen.getByText("2 drivers")).toBeInTheDocument();
  });

  // These live-only controls mount in the board's own toolbar, not under
  // the header on every route.
  it("mounts the live-only controls in the board toolbar: polls, delay, align", () => {
    renderWith(makePush());

    expect(screen.getByRole("button", { name: "Polls" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Live" })).toBeInTheDocument(); // DelayControl's back-to-live
    expect(screen.getByRole("button", { name: /Align with my screen/ })).toBeInTheDocument();
  });

  it("renders the empty state before any push arrives", () => {
    renderWith(null);
    expect(screen.getByText("LAP —")).toBeInTheDocument();
    expect(screen.getByText("Waiting for race state…")).toBeInTheDocument();
  });

  it("shows no banner while the session is live (the default fixture status)", () => {
    renderWith(makePush());
    expect(screen.queryByText(/This race has finished/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Race starts/)).not.toBeInTheDocument();
  });

  // ConnectionPill (live/ConnectionPill.tsx) reads through the board seam
  // like the rest of the toolbar, so -- unlike the tests above -- these
  // render `BoardPage` on the live store directly (no `BoardSourceProvider`),
  // the same as production: `BoardPage` never mounts one.
  it("mounts the connection pill in the toolbar when the live session is live", () => {
    resetLiveStore({ connection: "open", lastMessageAt: Date.now(), displayed: liveSessionPush("live") });
    render(
      <MemoryRouter>
        <BoardPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("Live · connected")).toBeInTheDocument();
  });

  it("mounts no connection pill when the live session has finished", () => {
    resetLiveStore({ connection: "open", lastMessageAt: Date.now(), displayed: liveSessionPush("finished") });
    render(
      <MemoryRouter>
        <BoardPage />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/connected|connecting|catching up|reconnecting|last update/i)).not.toBeInTheDocument();
  });

  it("shows the finished banner with a replay link when the session has finished", () => {
    renderWith(
      makePush({ session_key: "11361" }, { session: { session_key: "11361", name: "Race", country: "Italy", status: "finished" } }),
    );

    expect(screen.getByText("This race has finished. Showing its final state.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Watch the replay" });
    expect(link).toHaveAttribute("href", "/races/11361");
  });

  it("shows the upcoming banner when the session has not started", () => {
    renderWith(
      makePush(
        {},
        {
          session: { session_key: "11361", name: "Race", country: "Italy", status: "upcoming", date_start: "2026-09-08T12:00:00.000Z" },
          race_control: NOT_RACING_CONTROL,
          drivers: {},
          driver_order: [],
        },
      ),
    );

    expect(screen.getByText("Race starts 2026-09-08. Timing appears when the session goes live.")).toBeInTheDocument();
  });

  // The transport bar and align button act on the live push buffer, which
  // is frozen (finished) or empty (upcoming) in those states. They gate on
  // `useBoardIsRacing()`, not the session row's status alone: the row can
  // lag the fold by one lifecycle check, so a race-control status or
  // leader lap already showing racing has begun renders them regardless of
  // what the row still says, short of "finished". F3.
  describe("transport bar and align button, racing gate", () => {
    it("shows the transport bar and align button while the session is live", () => {
      renderWith(makePush());

      expect(screen.getByRole("slider", { name: "Playback position" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Align with my screen/ })).toBeInTheDocument();
    });

    // "finished" wins even with both racing signals present (the default
    // fixture's race control already reads SESSION STARTED and its leader
    // is on lap 12): a row that has caught up to the end of the race is
    // never overridden by a leftover racing signal.
    it("hides the transport bar and align button when the session has finished, and shows the replay banner", () => {
      renderWith(
        makePush({ session_key: "11361" }, { session: { session_key: "11361", name: "Race", country: "Italy", status: "finished" } }),
      );

      expect(screen.queryByRole("slider", { name: "Playback position" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Align with my screen/ })).not.toBeInTheDocument();
      expect(screen.getByText("This race has finished. Showing its final state.")).toBeInTheDocument();
    });

    // The row lags the fold by at most one push (the api-side decision this
    // web slice depends on): the gate must not wait for the row alone.
    it("shows the transport bar and align button, and no upcoming banner, when the row is upcoming but race control shows SESSION STARTED", () => {
      renderWith(
        makePush(
          {},
          {
            session: { session_key: "11361", name: "Race", country: "Italy", status: "upcoming", date_start: "2026-09-08T12:00:00.000Z" },
            race_control: { ...NOT_RACING_CONTROL, session_status: "SESSION STARTED" },
            drivers: {},
            driver_order: [],
          },
        ),
      );

      expect(screen.getByRole("slider", { name: "Playback position" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Align with my screen/ })).toBeInTheDocument();
      expect(screen.queryByText(/Race starts/)).not.toBeInTheDocument();
    });

    it("shows the transport bar and align button, and no upcoming banner, when the row is upcoming but the leader's lap is already 1+", () => {
      const driver = makeDriver({ driver_number: 1, current_lap: 1 });
      renderWith(
        makePush(
          {},
          {
            session: { session_key: "11361", name: "Race", country: "Italy", status: "upcoming", date_start: "2026-09-08T12:00:00.000Z" },
            race_control: NOT_RACING_CONTROL,
            drivers: { "1": driver },
            driver_order: [1],
          },
        ),
      );

      expect(screen.getByRole("slider", { name: "Playback position" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Align with my screen/ })).toBeInTheDocument();
      expect(screen.queryByText(/Race starts/)).not.toBeInTheDocument();
    });

    it("hides the transport bar and shows the upcoming banner when the row is upcoming and neither signal says racing has begun", () => {
      renderWith(
        makePush(
          {},
          {
            session: { session_key: "11361", name: "Race", country: "Italy", status: "upcoming", date_start: "2026-09-08T12:00:00.000Z" },
            race_control: NOT_RACING_CONTROL,
            drivers: {},
            driver_order: [],
          },
        ),
      );

      expect(screen.queryByRole("slider", { name: "Playback position" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Align with my screen/ })).not.toBeInTheDocument();
      expect(screen.getByText("Race starts 2026-09-08. Timing appears when the session goes live.")).toBeInTheDocument();
    });

    // Regression: the timeline used to be built with only a session_key, so
    // once a rewound viewer fell into timeline mode the displayed push's
    // session lost its status and both the transport bar and the align
    // button (gated on `useBoardSessionStatus() === "live"`) disappeared.
    // No `BoardSourceProvider` here -- unlike the other tests in this file
    // -- so `BoardPage` reads the live store's own `displayed` push, the
    // same as it does in production.
    it("still shows the transport bar and align button after a seek rewinds past the buffer into timeline mode", async () => {
      const push = makePush();
      const timeline = createTimeline(push.state.session!);
      await appendEvents(timeline, [
        { event_id: "t1", endpoint: "position", source_time: "2026-09-08T12:00:00.000Z", payload: { driver_number: 1, position: 1 } },
      ]);

      const now = Date.now();
      useLiveStore.getState().onState(push, now);
      useLiveStore.getState().setTimeline(timeline, now);
      useLiveStore.getState().setDelayMs(60_000, now);

      render(
        <MemoryRouter>
          <BoardPage />
        </MemoryRouter>,
      );

      expect(useLiveStore.getState().mode).toBe("timeline");
      expect(screen.getByRole("slider", { name: "Playback position" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Align with my screen/ })).toBeInTheDocument();
      expect(screen.queryByText(/This race has finished/)).not.toBeInTheDocument();
    });

    it("keeps the polls button mounted on every session status", () => {
      renderWith(
        makePush({ session_key: "11361" }, { session: { session_key: "11361", name: "Race", country: "Italy", status: "finished" } }),
      );
      expect(screen.getByRole("button", { name: "Polls" })).toBeInTheDocument();
    });
  });

  // The driver panel's selection lives in the URL: a row click sets
  // `?driver=`, clicking the same row again clears it, and Escape clears
  // it regardless of which row was clicked.
  it("clicking a row selects the driver (?driver=), clicking it again clears it, and Escape clears it", async () => {
    const user = userEvent.setup();
    const router = renderWithRouter(makePush());

    // Once the panel is open, "VER" also appears in the panel itself. The
    // side slot sits ahead of the table in DOM order (`Board.tsx`), so the
    // table's own match is not reliably the first one; find the "VER" that
    // is actually inside a table row instead.
    const clickDriverRow = () =>
      user.click(screen.getAllByText("VER").find((el) => el.closest("tr") !== null)!);

    await clickDriverRow();
    expect(router.state.location.search).toBe("?driver=1");
    expect(screen.getByText("Sector 1")).toBeInTheDocument(); // the driver panel is now showing

    await clickDriverRow();
    expect(router.state.location.search).toBe("");
    expect(screen.queryByText("Sector 1")).not.toBeInTheDocument();

    await clickDriverRow();
    expect(router.state.location.search).toBe("?driver=1");

    await user.keyboard("{Escape}");
    expect(router.state.location.search).toBe("");
    expect(screen.queryByText("Sector 1")).not.toBeInTheDocument();
  });

  // LiveTimelineLoader is keyed off the *live* push's own session (never
  // the *displayed* one, which BoardSourceProvider supplies here and which
  // stays the default "live" fixture throughout).
  describe("LiveTimelineLoader mount latch", () => {
    it("mounts when the live session's status is live", () => {
      resetLiveStore({ live: liveSessionPush("live") });
      renderWith(makePush());
      expect(LiveTimelineLoader).toHaveBeenCalled();
    });

    it("does not mount for an upcoming live session", () => {
      resetLiveStore({ live: liveSessionPush("upcoming") });
      renderWith(makePush());
      expect(LiveTimelineLoader).not.toHaveBeenCalled();
    });

    // The row can lag the fold by one lifecycle check, same as the
    // transport bar and align button: race control's own SESSION STARTED
    // is enough to mount the loader even while the row still says upcoming.
    it("mounts for an upcoming live session when race control shows SESSION STARTED", () => {
      resetLiveStore({ live: liveSessionPush("upcoming", { race_control: { ...NOT_RACING_CONTROL, session_status: "SESSION STARTED" } }) });
      renderWith(makePush());
      expect(LiveTimelineLoader).toHaveBeenCalled();
    });

    it("does not mount for a live session already finished when the page mounts", () => {
      resetLiveStore({ live: liveSessionPush("finished") });
      renderWith(makePush());
      expect(LiveTimelineLoader).not.toHaveBeenCalled();
    });

    // "finished" wins even with race control still reading SESSION STARTED.
    it("does not mount for a live session already finished, even with race control showing SESSION STARTED", () => {
      resetLiveStore({ live: liveSessionPush("finished", { race_control: { ...NOT_RACING_CONTROL, session_status: "SESSION STARTED" } }) });
      renderWith(makePush());
      expect(LiveTimelineLoader).not.toHaveBeenCalled();
    });

    it("stays mounted when the live session's status goes live -> finished", () => {
      resetLiveStore({ live: liveSessionPush("live") });
      renderWith(makePush());
      expect(LiveTimelineLoader).toHaveBeenCalled();
      vi.mocked(LiveTimelineLoader).mockClear();

      act(() => {
        useLiveStore.setState({ live: liveSessionPush("finished") });
      });

      expect(LiveTimelineLoader).toHaveBeenCalled();
    });

    it("passes the live session's numeric key and current status", () => {
      resetLiveStore({ live: liveSessionPush("live") });
      renderWith(makePush());
      expect(vi.mocked(LiveTimelineLoader).mock.calls[0]![0]).toEqual(expect.objectContaining({ sessionKey: 9999, status: "live" }));
    });
  });
});
