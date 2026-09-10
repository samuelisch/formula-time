// `TransportBar` is the one control surface for both platforms (live and
// replay), driven through the `TimeTarget` seam. Both platforms are
// exercised through hand-rolled `TimeTarget` fakes rather than the real
// live store or playback clock, so this file only pins `TransportBar`'s
// own behavior against the seam.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Anchors } from "../live/anchors.ts";
import { emptyAnchors } from "../live/anchors.ts";
import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import type { RewindMode } from "../live/types.ts";
import { makePush } from "../test/fixtures.ts";
import { TimeTargetProvider } from "./TimeTarget.ts";
import type { TimeTarget } from "./TimeTarget.ts";
import { TransportBar } from "./TransportBar.tsx";
import { useLiveTimeTarget } from "./useLiveTimeTarget.ts";

const NO_ANCHORS: Anchors = { lights_out: null, laps: [], restarts: [] };
const ANCHORS_WITH_LAP_5: Anchors = {
  lights_out: "2026-09-06T13:00:00.000Z",
  laps: [
    { lap: 1, source_time: "2026-09-06T13:00:00.000Z" },
    { lap: 5, source_time: "2026-09-06T13:04:00.000Z" },
  ],
  restarts: [],
};

/** A live-shaped fake: `playback()` is always null, `seekTo`/`nudge` mutate `state.displayedAtMs` directly like the delay-backed implementation would. */
function makeLiveFake(overrides: {
  displayedAtMs?: number | null;
  range?: { startMs: number; endMs: number } | null;
  anchors?: Anchors;
  notice?: string | null;
  syncOffsetMs?: number | null;
  rewindMode?: RewindMode | null;
} = {}): TimeTarget & { seekTo: ReturnType<typeof vi.fn<(atMs: number) => void>>; nudge: ReturnType<typeof vi.fn<(deltaMs: number) => void>> } {
  const range = "range" in overrides ? overrides.range! : { startMs: 0, endMs: 180_000 };
  const displayedAtMs = "displayedAtMs" in overrides ? overrides.displayedAtMs! : (range?.endMs ?? null);
  return {
    displayedAt: () => displayedAtMs,
    seekTo: vi.fn<(atMs: number) => void>(),
    nudge: vi.fn<(deltaMs: number) => void>(),
    anchors: () => overrides.anchors ?? NO_ANCHORS,
    range: () => range,
    playback: () => null,
    notice: () => overrides.notice ?? null,
    syncOffsetMs: () => ("syncOffsetMs" in overrides ? overrides.syncOffsetMs! : 0),
    rewindMode: () => overrides.rewindMode ?? "buffer",
  };
}

/** A replay-shaped fake: `playback()` is non-null and mutable. */
function makeReplayFake(overrides: {
  displayedAtMs?: number | null;
  range?: { startMs: number; endMs: number } | null;
  anchors?: Anchors;
  playing?: boolean;
  syncOffsetMs?: number | null;
} = {}): TimeTarget & {
  seekTo: ReturnType<typeof vi.fn<(atMs: number) => void>>;
  nudge: ReturnType<typeof vi.fn<(deltaMs: number) => void>>;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
} {
  const range = overrides.range ?? { startMs: 0, endMs: 90_000 };
  const displayedAtMs = overrides.displayedAtMs ?? range.startMs;
  const playing = overrides.playing ?? false;
  const syncOffsetMs = "syncOffsetMs" in overrides ? overrides.syncOffsetMs! : 0;
  const play = vi.fn();
  const pause = vi.fn();
  return {
    displayedAt: () => displayedAtMs,
    seekTo: vi.fn<(atMs: number) => void>(),
    nudge: vi.fn<(deltaMs: number) => void>(),
    anchors: () => overrides.anchors ?? NO_ANCHORS,
    range: () => range,
    playback: () => ({ playing, play, pause }),
    notice: () => null,
    syncOffsetMs: () => syncOffsetMs,
    rewindMode: () => null,
    play,
    pause,
  };
}

function renderBar(target: TimeTarget): void {
  render(
    <TimeTargetProvider value={target}>
      <TransportBar />
    </TimeTargetProvider>,
  );
}

describe("TransportBar -- live", () => {
  it("nudges by 5s and 10s in both directions through target.nudge()", async () => {
    const user = userEvent.setup();
    const target = makeLiveFake();
    renderBar(target);

    await user.click(screen.getByRole("button", { name: "+5s" }));
    expect(target.nudge).toHaveBeenLastCalledWith(5_000);
    await user.click(screen.getByRole("button", { name: "+10s" }));
    expect(target.nudge).toHaveBeenLastCalledWith(10_000);
    await user.click(screen.getByRole("button", { name: "−5s" }));
    expect(target.nudge).toHaveBeenLastCalledWith(-5_000);
    await user.click(screen.getByRole("button", { name: "−10s" }));
    expect(target.nudge).toHaveBeenLastCalledWith(-10_000);
  });

  it("shows a Live button (no Play/Pause) that seeks to the end of the range", async () => {
    const user = userEvent.setup();
    const target = makeLiveFake({ range: { startMs: 0, endMs: 50_000 } });
    renderBar(target);

    expect(screen.queryByRole("button", { name: "Play" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Live" }));
    expect(target.seekTo).toHaveBeenCalledWith(50_000);
  });

  it("sets the slider's bounds from range() and shows the delay in seconds", () => {
    const target = makeLiveFake({ range: { startMs: 0, endMs: 180_000 }, displayedAtMs: 175_000, syncOffsetMs: 5_000 });
    renderBar(target);

    const slider = screen.getByRole("slider", { name: "Playback position" }) as HTMLInputElement;
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("180000");
    expect(slider.value).toBe("175000");
    expect(screen.getByText("5.0s")).toBeInTheDocument();
  });

  it("shows 0.0s when the delay is zero, even while the displayed position sits behind the range's end", () => {
    const target = makeLiveFake({ range: { startMs: 0, endMs: 180_000 }, displayedAtMs: 175_000, syncOffsetMs: 0 });
    renderBar(target);
    expect(screen.getByText("0.0s")).toBeInTheDocument();
  });

  it("shows the timeline-mode readout when rewindMode() is 'timeline'", () => {
    const target = makeLiveFake({ range: { startMs: 0, endMs: 180_000 }, displayedAtMs: 168_000, rewindMode: "timeline", syncOffsetMs: 12_000 });
    renderBar(target);
    expect(screen.getByText("Rewound 12.0s · from the log")).toBeInTheDocument();
  });

  it("shows the plain seconds readout when rewindMode() is 'buffer', not the timeline wording", () => {
    const target = makeLiveFake({ range: { startMs: 0, endMs: 180_000 }, displayedAtMs: 168_000, rewindMode: "buffer", syncOffsetMs: 12_000 });
    renderBar(target);
    expect(screen.getByText("12.0s")).toBeInTheDocument();
    expect(screen.queryByText(/from the log/)).not.toBeInTheDocument();
  });

  it("shows — when syncOffsetMs() is null", () => {
    const target = makeLiveFake({ range: { startMs: 0, endMs: 180_000 }, displayedAtMs: 168_000, syncOffsetMs: null });
    renderBar(target);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows — before the first push, even though syncOffsetMs() already defaults to 0", () => {
    const target = makeLiveFake({ range: null, displayedAtMs: null, syncOffsetMs: 0 });
    renderBar(target);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("disables the slider when range() is null", () => {
    const target = makeLiveFake({ range: null, displayedAtMs: null });
    renderBar(target);
    expect((screen.getByRole("slider", { name: "Playback position" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("nudges with the [ ] , . keys", async () => {
    const user = userEvent.setup();
    const target = makeLiveFake();
    renderBar(target);

    await user.keyboard("{]}");
    expect(target.nudge).toHaveBeenLastCalledWith(1_000);
    await user.keyboard("{[}");
    expect(target.nudge).toHaveBeenLastCalledWith(-1_000);
    await user.keyboard(".");
    expect(target.nudge).toHaveBeenLastCalledWith(5_000);
    await user.keyboard(",");
    expect(target.nudge).toHaveBeenLastCalledWith(-5_000);
  });

  it("shows a message when Race start has not been seen yet", async () => {
    const user = userEvent.setup();
    const target = makeLiveFake({ anchors: NO_ANCHORS });
    renderBar(target);

    await user.click(screen.getByRole("button", { name: "Race start" }));
    expect(screen.getByText("Race start not seen since you joined")).toBeInTheDocument();
    expect(target.seekTo).not.toHaveBeenCalled();
  });

  it("Race start seeks to the lights-out anchor", async () => {
    const user = userEvent.setup();
    const target = makeLiveFake({ anchors: ANCHORS_WITH_LAP_5 });
    renderBar(target);

    await user.click(screen.getByRole("button", { name: "Race start" }));
    expect(target.seekTo).toHaveBeenCalledWith(Date.parse("2026-09-06T13:00:00.000Z"));
  });

  it("shows a message when jumping to a lap that has not been seen", async () => {
    const user = userEvent.setup();
    const target = makeLiveFake({ anchors: NO_ANCHORS });
    renderBar(target);

    await user.type(screen.getByRole("spinbutton", { name: "Lap number" }), "5");
    await user.click(screen.getByRole("button", { name: "Go" }));

    expect(screen.getByText("Lap 5 not seen since you joined")).toBeInTheDocument();
    expect(target.seekTo).not.toHaveBeenCalled();
  });

  it("jumps to a known lap's anchor", async () => {
    const user = userEvent.setup();
    const target = makeLiveFake({ anchors: ANCHORS_WITH_LAP_5 });
    renderBar(target);

    await user.type(screen.getByRole("spinbutton", { name: "Lap number" }), "5");
    await user.click(screen.getByRole("button", { name: "Go" }));

    expect(target.seekTo).toHaveBeenCalledWith(Date.parse("2026-09-06T13:04:00.000Z"));
    expect(screen.queryByText(/not seen since you joined/)).not.toBeInTheDocument();
  });
});

describe("TransportBar -- replay", () => {
  it("shows Play when paused and Pause when playing, wired to playback().play()/pause()", async () => {
    const user = userEvent.setup();
    const target = makeReplayFake({ playing: false });
    renderBar(target);

    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(target.play).toHaveBeenCalled();
  });

  it("shows Pause and calls pause() when already playing", async () => {
    const user = userEvent.setup();
    const target = makeReplayFake({ playing: true });
    renderBar(target);

    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(target.pause).toHaveBeenCalled();
  });

  it("shows no Live button on replay", () => {
    const target = makeReplayFake();
    renderBar(target);
    expect(screen.queryByRole("button", { name: "Live" })).not.toBeInTheDocument();
  });

  it("sets the slider's bounds from range()", () => {
    const target = makeReplayFake({
      range: { startMs: Date.parse("2026-09-06T13:00:00.000Z"), endMs: Date.parse("2026-09-06T13:01:30.000Z") },
      displayedAtMs: Date.parse("2026-09-06T13:00:30.000Z"),
    });
    renderBar(target);

    const slider = screen.getByRole("slider", { name: "Playback position" }) as HTMLInputElement;
    expect(slider.min).toBe(String(Date.parse("2026-09-06T13:00:00.000Z")));
    expect(slider.max).toBe(String(Date.parse("2026-09-06T13:01:30.000Z")));
  });

  // Replay-only wording: the readout is the sync offset in seconds
  // relative to the un-nudged clock, not the absolute source clock -- 0
  // for a fold that has only ever played straight through, signed once a
  // nudge or auto-align has moved it.
  it("shows the sync offset in seconds relative to the un-nudged clock, signed", () => {
    const atRest = makeReplayFake({ syncOffsetMs: 0 });
    renderBar(atRest);
    expect(screen.getByText("0.0s")).toBeInTheDocument();

    const nudgedForward = makeReplayFake({ syncOffsetMs: 5_000 });
    renderBar(nudgedForward);
    expect(screen.getByText("+5.0s")).toBeInTheDocument();

    const nudgedBack = makeReplayFake({ syncOffsetMs: -2_500 });
    renderBar(nudgedBack);
    expect(screen.getByText("-2.5s")).toBeInTheDocument();
  });

  it("falls back to the absolute source clock when syncOffsetMs() returns null (no fold loaded yet)", () => {
    const range = { startMs: 0, endMs: 90_000 };
    const displayedAtMs = Date.parse("2026-09-06T13:00:30.000Z");
    // `syncOffsetMs` is non-optional on `TimeTarget`, but a replay before
    // its fold has loaded still returns null (`useReplayTimeTarget`) --
    // the fallback this test covers.
    const target: TimeTarget = {
      displayedAt: () => displayedAtMs,
      seekTo: vi.fn(),
      nudge: vi.fn(),
      anchors: () => NO_ANCHORS,
      range: () => range,
      playback: () => ({ playing: false, play: vi.fn(), pause: vi.fn() }),
      notice: () => null,
      syncOffsetMs: () => null,
      rewindMode: () => null,
    };
    renderBar(target);
    expect(screen.getByText("13:00:30 UTC")).toBeInTheDocument();
  });

  it("Race start seeks to the lights-out anchor and pauses playback", async () => {
    const user = userEvent.setup();
    const target = makeReplayFake({ anchors: ANCHORS_WITH_LAP_5, playing: true });
    renderBar(target);

    await user.click(screen.getByRole("button", { name: "Race start" }));
    expect(target.seekTo).toHaveBeenCalledWith(Date.parse("2026-09-06T13:00:00.000Z"));
    expect(target.pause).toHaveBeenCalled();
  });

  it("Go to a known lap seeks and pauses playback", async () => {
    const user = userEvent.setup();
    const target = makeReplayFake({ anchors: ANCHORS_WITH_LAP_5, playing: true });
    renderBar(target);

    await user.type(screen.getByRole("spinbutton", { name: "Lap number" }), "5");
    await user.click(screen.getByRole("button", { name: "Go" }));

    expect(target.seekTo).toHaveBeenCalledWith(Date.parse("2026-09-06T13:04:00.000Z"));
    expect(target.pause).toHaveBeenCalled();
  });
});

describe("TransportBar -- shortcuts legend", () => {
  it("shows the keyboard shortcuts as a visible legend rather than only a tooltip", () => {
    renderBar(makeLiveFake());
    expect(screen.getByText("Keys: [ and ] nudge 1 s · , and . nudge 5 s")).toBeInTheDocument();
  });
});

describe("TransportBar -- notice()", () => {
  it("renders the target's notice under the row, and nothing when there is none", () => {
    const { unmount } = render(
      <TimeTargetProvider value={makeLiveFake({ notice: "Delay exceeds what this tab has buffered; showing the oldest" })}>
        <TransportBar />
      </TimeTargetProvider>,
    );
    expect(screen.getByText("Delay exceeds what this tab has buffered; showing the oldest")).toBeInTheDocument();
    unmount();

    renderBar(makeLiveFake());
    expect(screen.queryByText(/showing the oldest/)).not.toBeInTheDocument();
  });

  it("shows a notice alongside a failed jump message rather than replacing it", async () => {
    const user = userEvent.setup();
    renderBar(makeLiveFake({ notice: "Delay exceeds what this tab has buffered; showing the oldest" }));

    await user.click(screen.getByRole("button", { name: "Race start" }));

    expect(screen.getByText("Race start not seen since you joined")).toBeInTheDocument();
    expect(screen.getByText("Delay exceeds what this tab has buffered; showing the oldest")).toBeInTheDocument();
  });
});

// The Live button and the position readout must read
// `target.range()`/`target.displayedAt()` fresh at click time, not the
// value `TransportBar` captured in its own render scope -- that closure
// goes stale the instant real time keeps passing without a re-render,
// which nothing forces here between mount and the click. Uses the real
// `useLiveTimeTarget` (not a fake) precisely because the bug lived in the
// integration between the hook's always-fresh `range()`/`seekTo()` and
// TransportBar's own closures, not in the hook alone.
function LiveTransportBar({ now }: { now: () => number }) {
  const target = useLiveTimeTarget(now);
  return (
    <TimeTargetProvider value={target}>
      <TransportBar />
    </TimeTargetProvider>
  );
}

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

describe("TransportBar -- live, real useLiveTimeTarget (regression: stale range() at click time)", () => {
  beforeEach(() => resetLiveStore());

  it("Live sets the delay to exactly 0 even when clicked well after the last render, and the readout reflects it", async () => {
    const user = userEvent.setup();

    // Real (parseable) pushes, not placeholder JSON -- a nonzero delay makes
    // the store actually parse a buffered entry into `displayed`
    // (`reselect` in `live/store.ts`), and this test's whole point is to
    // exercise that path under a stale delay reading.
    function bufferedPush(atMs: number) {
      return JSON.stringify(makePush({ sent_at: atMs }, { latest_source_time: null }));
    }
    const bufferedSpan = { entries: [{ at: 0, raw: bufferedPush(0) }, { at: 1_000_000, raw: bufferedPush(1_000_000) }] };
    let nowMs = 1_000_000;
    const now = () => nowMs;

    // A live push at exactly the wall time the click will land on, so a
    // correct delay of 0 renders as "0.0s" rather than some huge number --
    // `axisOf` falls back to `sent_at` when `latest_source_time` is null.
    const liveEdgePush = makePush({ sent_at: 1_030_000 }, { latest_source_time: null });
    resetLiveStore({ buffer: bufferedSpan, delayMs: 90_000, live: liveEdgePush });

    render(<LiveTransportBar now={now} />);

    // Time passes with nothing that would trigger a re-render (`now` isn't
    // React state): the render-scoped `range` TransportBar captured at
    // mount (endMs = 1_000_000) is now 30s stale.
    nowMs += 30_000;

    await user.click(screen.getByRole("button", { name: "Live" }));

    expect(useLiveStore.getState().delayMs).toBe(0); // not 30_000, the buggy reading of the stale `range`
    expect(screen.getByText("0.0s")).toBeInTheDocument();
  });
});
