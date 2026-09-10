// The `/live` route = the pure `Board` (covered by board/Board.test.tsx)
// plus the live-only furniture: the finished/upcoming banner, polls, and the
// delay/align controls that moved out of `Shell` in issue #57 fix round 5.
// These tests cover that furniture and the fact that it is mounted here, not
// in the shell and not on a replay.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";

import { BoardSourceProvider } from "../board/useBoardState.ts";
import { emptyAnchors } from "../live/anchors.ts";
import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import { makePush } from "../test/fixtures.ts";
import { BoardPage } from "./BoardPage.tsx";

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

function liveSessionPush(status: "upcoming" | "live" | "finished"): ReturnType<typeof makePush> {
  return makePush({}, { session: { session_key: "9999", name: "Race", country: "Italy", status } });
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

  // Moved out of Shell (where they sat under the header on every route,
  // replay included) into the board's own toolbar.
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

  // ConnectionPill (live/ConnectionPill.tsx) reads the live store's own
  // `displayed` session, not the `BoardSourceProvider` push `renderWith`
  // supplies here -- set it directly, as the mount-latch tests below do for
  // `live`.
  it("mounts the connection pill in the toolbar when the live session is live", () => {
    resetLiveStore({ connection: "open", lastMessageAt: Date.now(), displayed: liveSessionPush("live") });
    renderWith(makePush());
    expect(screen.getByText("Live · connected")).toBeInTheDocument();
  });

  it("mounts no connection pill when the live session has finished", () => {
    resetLiveStore({ connection: "open", lastMessageAt: Date.now(), displayed: liveSessionPush("finished") });
    renderWith(makePush());
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
        { session: { session_key: "11361", name: "Race", country: "Italy", status: "upcoming", date_start: "2026-09-08T12:00:00.000Z" } },
      ),
    );

    expect(screen.getByText("Race starts 2026-09-08. Timing appears when the session goes live.")).toBeInTheDocument();
  });

  // The transport bar and align button act on the live push buffer, which
  // is frozen (finished) or empty (upcoming) in those states -- only a
  // live session gets row 2. F3.
  describe("transport bar and align button, live-only", () => {
    it("shows the transport bar and align button while the session is live", () => {
      renderWith(makePush());

      expect(screen.getByRole("slider", { name: "Playback position" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Align with my screen/ })).toBeInTheDocument();
    });

    it("hides the transport bar and align button when the session has finished, and shows the replay banner", () => {
      renderWith(
        makePush({ session_key: "11361" }, { session: { session_key: "11361", name: "Race", country: "Italy", status: "finished" } }),
      );

      expect(screen.queryByRole("slider", { name: "Playback position" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Align with my screen/ })).not.toBeInTheDocument();
      expect(screen.getByText("This race has finished. Showing its final state.")).toBeInTheDocument();
    });

    it("hides the transport bar when the session is upcoming, and shows the upcoming banner", () => {
      renderWith(
        makePush(
          {},
          { session: { session_key: "11361", name: "Race", country: "Italy", status: "upcoming", date_start: "2026-09-08T12:00:00.000Z" } },
        ),
      );

      expect(screen.queryByRole("slider", { name: "Playback position" })).not.toBeInTheDocument();
      expect(screen.getByText("Race starts 2026-09-08. Timing appears when the session goes live.")).toBeInTheDocument();
    });

    it("keeps the polls button mounted on every session status", () => {
      renderWith(
        makePush({ session_key: "11361" }, { session: { session_key: "11361", name: "Race", country: "Italy", status: "finished" } }),
      );
      expect(screen.getByRole("button", { name: "Polls" })).toBeInTheDocument();
    });
  });

  // The driver panel's selection lives in the URL (issue #90): a row click
  // sets `?driver=`, clicking the same row again clears it, and Escape
  // clears it regardless of which row was clicked.
  it("clicking a row selects the driver (?driver=), clicking it again clears it, and Escape clears it", async () => {
    const user = userEvent.setup();
    const router = renderWithRouter(makePush());

    // Once the panel is open, "VER" also appears in the panel itself. The
    // side slot sits ahead of the table in DOM order (issue #90 fix round
    // 1, Board.tsx), so the table's own match is not reliably the first
    // one; find the "VER" that is actually inside a table row instead.
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

    it("does not mount for a live session already finished when the page mounts", () => {
      resetLiveStore({ live: liveSessionPush("finished") });
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
