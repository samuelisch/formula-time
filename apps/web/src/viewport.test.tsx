// The phone-width responsive pass (apps/web/AGENTS.md). Two kinds of case
// live here: a pure CSS collapse (the timing table's Team column, the
// transport bar's tap targets) needs no pixel measurement -- jsdom does not
// apply stylesheet rules -- but the elements a narrow media query targets
// must carry the class (or be hidden) that query relies on, so a future
// refactor that drops the class is caught here. The other kind reads the
// breakpoint in JS (src/lib/useNarrowViewport.ts) -- the align panel's
// default-collapsed state and the poll modal's bottom-sheet variant -- plus
// a narrow-stub smoke render of every route page. Every case renders under
// the narrow matchMedia stub (src/test/matchMedia.ts) and asserts class
// names or hidden elements, not pixels.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";

import { AlignPanel } from "./align/AlignPanel.tsx";
import { TimingTable } from "./board/TimingTable.tsx";
import { BoardSourceProvider } from "./board/useBoardState.ts";
import { useNarrowViewport } from "./lib/useNarrowViewport.ts";
import { emptyAnchors } from "./live/anchors.ts";
import { emptyBuffer } from "./live/buffer.ts";
import { useLiveStore } from "./live/store.ts";
import { BoardPage } from "./pages/BoardPage.tsx";
import { PollsPage } from "./pages/PollsPage.tsx";
import { RacesPage } from "./pages/RacesPage.tsx";
import { ReplayPage } from "./pages/ReplayPage.tsx";
import { makePoll } from "./polls/pollFixtures.ts";
import { PollModal } from "./polls/PollModal.tsx";
import { usePollModalUiStore } from "./polls/pollModalStore.ts";
import type { RaceFile, RaceIndexEntry } from "./races/api.ts";
import { makeDriver, makePush } from "./test/fixtures.ts";
import { installNarrowMatchMedia } from "./test/matchMedia.ts";
import { TimeTargetProvider, type TimeTarget } from "./transport/TimeTarget.ts";
import { TransportBar } from "./transport/TransportBar.tsx";
import { useLiveTimeTarget } from "./transport/useLiveTimeTarget.ts";

// Same three real-browser/npm-package APIs AlignPanel.test.tsx stubs --
// jsdom implements neither getDisplayMedia nor tesseract.js.
vi.mock("./align/capture.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./align/capture.ts")>();
  return {
    ...actual,
    loadTesseract: vi.fn(),
    captureDisplayMedia: vi.fn(),
    createOcrWorker: vi.fn(),
  };
});
const { captureDisplayMedia, createOcrWorker, loadTesseract } = await import("./align/capture.ts");

vi.mock("./live/LiveTimelineLoader.tsx", () => ({
  LiveTimelineLoader: vi.fn(() => null),
}));

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
    ...overrides,
  });
}

describe("TimingTable under a narrow viewport", () => {
  let stub: { restore: () => void };

  beforeEach(() => {
    stub = installNarrowMatchMedia(true);
  });

  afterEach(() => {
    stub.restore();
  });

  it("marks the driver full name and the team name for the narrow-width collapse", () => {
    const driver = makeDriver({
      driver_number: 1,
      name_acronym: "VER",
      full_name: "Max Verstappen",
      team_name: "Red Bull Racing",
      position: 1,
    });
    render(
      <MemoryRouter>
        <BoardSourceProvider push={makePush({}, { drivers: { "1": driver }, driver_order: [1] })}>
          <TimingTable />
        </BoardSourceProvider>
      </MemoryRouter>,
    );

    const fullName = screen.getByText("Max Verstappen");
    const teamName = screen.getByText("Red Bull Racing");
    // TimingTable.module.css hides both under --bp-narrow (640px) -- these
    // classes are what that media query selects.
    expect(teamName.className).toMatch(/teamName/);
    // The full name's <br /> lives inside the same hidden wrapper as the
    // name itself, so the narrow collapse drops the line break too --
    // otherwise the cell would still keep the empty second line the CSS
    // comment claims is gone.
    const fullNameWrapper = fullName.parentElement;
    expect(fullNameWrapper?.className).toMatch(/fullName/);
    expect(fullNameWrapper?.querySelector("br")).not.toBeNull();
  });
});

describe("TransportBar under a narrow viewport", () => {
  let stub: { restore: () => void };

  const target: TimeTarget = {
    displayedAt: () => 0,
    seekTo: () => {},
    nudge: () => {},
    anchors: () => ({ lights_out: null, laps: [], restarts: [] }),
    range: () => ({ startMs: 0, endMs: 180_000 }),
    playback: () => null,
    notice: () => null,
    syncOffsetMs: () => 0,
    rewindMode: () => "buffer",
  };

  beforeEach(() => {
    stub = installNarrowMatchMedia(true);
  });

  afterEach(() => {
    stub.restore();
  });

  it("marks every button and the lap-jump input for the 40px tap target", () => {
    render(
      <TimeTargetProvider value={target}>
        <TransportBar />
      </TimeTargetProvider>,
    );

    // TransportBar.module.css grows `.control` to a 40px min-height under
    // --bp-narrow -- every plain button and the lap input carry it.
    const buttons = ["−10s", "−5s", "Live", "+5s", "+10s", "Race start", "Go"].map((name) =>
      screen.getByRole("button", { name }),
    );
    for (const button of buttons) {
      expect(button.className).toMatch(/control/);
    }
    expect(screen.getByLabelText("Lap number").className).toMatch(/control/);
  });
});

describe("useNarrowViewport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads false with no matchMedia available (jsdom's default)", () => {
    function Probe() {
      return <span>{String(useNarrowViewport())}</span>;
    }
    render(<Probe />);
    expect(screen.getByText("false")).toBeInTheDocument();
  });

  it("reads true once the narrow-viewport stub is installed", () => {
    const stub = installNarrowMatchMedia(true);
    function Probe() {
      return <span>{String(useNarrowViewport())}</span>;
    }
    render(<Probe />);
    expect(screen.getByText("true")).toBeInTheDocument();
    stub.restore();
  });
});

describe("AlignPanel under a narrow viewport", () => {
  function LiveAlignPanel() {
    const target = useLiveTimeTarget();
    return (
      <TimeTargetProvider value={target}>
        <AlignPanel />
      </TimeTargetProvider>
    );
  }

  let stub: { restore: () => void };

  beforeEach(() => {
    resetLiveStore();
    vi.mocked(loadTesseract).mockReset();
    vi.mocked(captureDisplayMedia).mockReset();
    vi.mocked(createOcrWorker).mockReset();
    // Never resolves -- the panel is up in its "starting" busy state, which
    // is enough to see whether it opened collapsed or expanded.
    vi.mocked(loadTesseract).mockReturnValue(new Promise(() => {}));
    stub = installNarrowMatchMedia(true);
  });

  afterEach(() => {
    stub.restore();
  });

  it("opens collapsed to its tab, hiding the status and preview", async () => {
    const user = userEvent.setup();
    render(<LiveAlignPanel />);
    await user.click(screen.getByRole("button", { name: /Align with my screen/ }));

    expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("expands on a tap of the collapse tab", async () => {
    const user = userEvent.setup();
    render(<LiveAlignPanel />);
    await user.click(screen.getByRole("button", { name: /Align with my screen/ }));
    await user.click(screen.getByRole("button", { name: "Expand" }));

    expect(screen.getByRole("status")).toHaveTextContent("Loading OCR…");
    expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument();
  });
});

describe("PollModal under a narrow viewport", () => {
  let stub: { restore: () => void };

  beforeEach(() => {
    usePollModalUiStore.setState({ isOpen: false, lastSignature: "", lastSessionKey: null });
  });

  afterEach(() => {
    stub?.restore();
  });

  function renderModal() {
    const queryClient = new QueryClient();
    return render(
      <QueryClientProvider client={queryClient}>
        <BoardSourceProvider push={makePush({ session_key: "session-1" })}>
          <PollModal polls={[makePoll({ poll_id: "poll-1", status: "open" })]} />
        </BoardSourceProvider>
      </QueryClientProvider>,
    );
  }

  it("renders the dialog as the bottom-sheet variant", () => {
    stub = installNarrowMatchMedia(true);
    renderModal();
    act(() => {
      usePollModalUiStore.getState().open();
    });

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toMatch(/sheet/);
  });

  it("keeps the centred dialog variant with no narrow stub installed", () => {
    renderModal();
    act(() => {
      usePollModalUiStore.getState().open();
    });

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).not.toMatch(/sheet/);
  });
});

describe("Every page mounts cleanly at phone width", () => {
  let stub: { restore: () => void };

  beforeEach(() => {
    stub = installNarrowMatchMedia(true);
    resetLiveStore();
    usePollModalUiStore.setState({ isOpen: false, lastSignature: "", lastSessionKey: null });
    vi.mocked(loadTesseract).mockReset();
    vi.mocked(captureDisplayMedia).mockReset();
    vi.mocked(createOcrWorker).mockReset();
  });

  afterEach(() => {
    stub.restore();
    vi.unstubAllGlobals();
  });

  it("RacesPage (the chooser)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([{ path: "/", element: <RacesPage /> }]);
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("No live session right now")).toBeInTheDocument();
  });

  it("BoardPage (the live board)", () => {
    render(
      <MemoryRouter>
        <BoardSourceProvider push={makePush()}>
          <BoardPage />
        </BoardSourceProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("2 drivers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Polls" })).toBeInTheDocument();
  });

  it("PollsPage", async () => {
    resetLiveStore({ connection: "open", statusReceived: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/races" ? [] : []), { status: 200 })),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([{ path: "/polls", element: <PollsPage /> }], { initialEntries: ["/polls"] });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("No polls for this race")).toBeInTheDocument();
  });

  it("ReplayPage", async () => {
    const raceFile: RaceFile = {
      schema: 1,
      exported_at: "2026-09-06T15:10:00.000Z",
      session: {
        session_key: 11361,
        name: "Race",
        country: "Italy",
        circuit_key: 39,
        date_start: "2026-09-06T13:00:00.000Z",
        date_end: "2026-09-06T15:00:00.000Z",
        total_laps: 2,
        status: "finished",
      },
      events: [],
    };
    const raceIndex: RaceIndexEntry[] = [
      {
        session_key: 11361,
        name: "Race",
        country: "Italy",
        date_start: "2026-09-06T13:00:00.000Z",
        date_end: "2026-09-06T15:00:00.000Z",
        total_laps: 2,
        exported_at: raceFile.exported_at,
        meeting_name: null,
        circuit_short_name: null,
        location: null,
      },
    ];
    // Routed by URL, same as the real api: the index (ReplayPage's own
    // exported_at lookup) and the file are two different routes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/races") return new Response(JSON.stringify(raceIndex), { status: 200 });
        return new Response(JSON.stringify(raceFile), { status: 200 });
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([{ path: "/races/:session_key", element: <ReplayPage /> }], {
      initialEntries: ["/races/11361"],
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("0 drivers")).toBeInTheDocument();
  });
});
