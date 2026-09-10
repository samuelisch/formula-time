import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LivePush } from "../live/types.ts";
import { useLiveStore } from "../live/store.ts";
import { makeDriver, makePush, makeState } from "../test/fixtures.ts";
import {
  BoardSourceProvider,
  useBoardDriver,
  useBoardDriverOrder,
  useBoardLeaderLap,
  useBoardPositionDeltas,
  useBoardPush,
  useBoardSessionMeta,
} from "./useBoardState.ts";

function Probe() {
  const push = useBoardPush();
  const order = useBoardDriverOrder();
  const leaderLap = useBoardLeaderLap();
  const { totalLaps } = useBoardSessionMeta();
  const driver = useBoardDriver(1);
  return (
    <div>
      <span data-testid="session-key">{push?.session_key ?? "none"}</span>
      <span data-testid="order">{order.join(",")}</span>
      <span data-testid="leader-lap">{leaderLap}</span>
      <span data-testid="total-laps">{totalLaps ?? "none"}</span>
      <span data-testid="driver-1">{driver?.name_acronym ?? "none"}</span>
    </div>
  );
}

describe("useBoardState", () => {
  it("falls back to the live store's displayed push when no provider is mounted", () => {
    useLiveStore.setState({ displayed: makePush() });
    render(<Probe />);
    expect(screen.getByTestId("session-key").textContent).toBe("9999");
    expect(screen.getByTestId("order").textContent).toBe("1,44");
    expect(screen.getByTestId("driver-1").textContent).toBe("VER");
  });

  it("renders null-shaped defaults when neither a provider nor a displayed push exists", () => {
    useLiveStore.setState({ displayed: null });
    render(<Probe />);
    expect(screen.getByTestId("session-key").textContent).toBe("none");
    expect(screen.getByTestId("order").textContent).toBe("");
    expect(screen.getByTestId("leader-lap").textContent).toBe("0");
    expect(screen.getByTestId("driver-1").textContent).toBe("none");
  });

  it("prefers the mounted provider's push over the live store", () => {
    useLiveStore.setState({ displayed: makePush({ session_key: "live-session" }) });
    const provided = makePush({ session_key: "replay-session" }, { driver_order: [44, 1] });
    render(
      <BoardSourceProvider push={provided}>
        <Probe />
      </BoardSourceProvider>,
    );
    expect(screen.getByTestId("session-key").textContent).toBe("replay-session");
    expect(screen.getByTestId("order").textContent).toBe("44,1");
  });

  it("a provider mounted with a null push renders the null-shaped defaults, not the live store", () => {
    useLiveStore.setState({ displayed: makePush({ session_key: "live-session" }) });
    render(
      <BoardSourceProvider push={null}>
        <Probe />
      </BoardSourceProvider>,
    );
    expect(screen.getByTestId("session-key").textContent).toBe("none");
  });
});

// useBoardPositionDeltas() cases: gain, loss, a new session resets
// silently, a backwards axis (replay rewind/scrub) resets silently, and a
// cue expires 8s after it was set, checked on the next render rather than
// a per-row timer.
function pushAt(sessionKey: string, sourceTimeIso: string, positions: Record<number, number>): LivePush {
  const drivers = Object.fromEntries(
    Object.entries(positions).map(([driverNumber, position]) => [
      driverNumber,
      makeDriver({ driver_number: Number(driverNumber), position }),
    ]),
  );
  return {
    type: "state",
    seq: "1",
    sent_at: Date.parse(sourceTimeIso),
    session_key: sessionKey,
    total_laps: 53,
    state: makeState({
      latest_source_time: sourceTimeIso,
      drivers,
      driver_order: Object.keys(positions)
        .map(Number)
        .sort((a, b) => positions[a]! - positions[b]!),
    }),
    polls: [],
  };
}

function DeltaProbe() {
  const deltas = useBoardPositionDeltas();
  return <span data-testid="deltas">{JSON.stringify(deltas)}</span>;
}

function readDeltas(): Record<number, number> {
  return JSON.parse(screen.getByTestId("deltas").textContent ?? "{}");
}

function renderWithPush(push: LivePush | null) {
  return render(
    <BoardSourceProvider push={push}>
      <DeltaProbe />
    </BoardSourceProvider>,
  );
}

describe("useBoardPositionDeltas", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits no deltas on the first push (nothing to compare against)", () => {
    renderWithPush(pushAt("9999", "2026-09-08T13:00:00.000Z", { 1: 1, 44: 2 }));
    expect(readDeltas()).toEqual({});
  });

  it("a positive delta when a driver gains places (previous - current > 0)", () => {
    const { rerender } = renderWithPush(pushAt("9999", "2026-09-08T13:00:00.000Z", { 1: 3, 44: 1 }));
    rerender(
      <BoardSourceProvider push={pushAt("9999", "2026-09-08T13:00:01.000Z", { 1: 1, 44: 3 })}>
        <DeltaProbe />
      </BoardSourceProvider>,
    );
    // Driver 1: 3 -> 1, gained 2 places.
    expect(readDeltas()).toEqual({ 1: 2, 44: -2 });
  });

  it("a negative delta when a driver loses places", () => {
    const { rerender } = renderWithPush(pushAt("9999", "2026-09-08T13:00:00.000Z", { 1: 1 }));
    rerender(
      <BoardSourceProvider push={pushAt("9999", "2026-09-08T13:00:01.000Z", { 1: 4 })}>
        <DeltaProbe />
      </BoardSourceProvider>,
    );
    expect(readDeltas()).toEqual({ 1: -3 });
  });

  it("a new session_key resets the baseline silently, even though the raw position numbers differ", () => {
    const { rerender } = renderWithPush(pushAt("9999", "2026-09-08T13:00:00.000Z", { 1: 1 }));
    rerender(
      <BoardSourceProvider push={pushAt("11361", "2026-09-08T13:00:01.000Z", { 1: 5 })}>
        <DeltaProbe />
      </BoardSourceProvider>,
    );
    expect(readDeltas()).toEqual({});
  });

  it("the push's axis going backwards (a replay rewind/scrub) resets the baseline silently", () => {
    const { rerender } = renderWithPush(pushAt("9999", "2026-09-08T13:00:10.000Z", { 1: 2 }));
    rerender(
      <BoardSourceProvider push={pushAt("9999", "2026-09-08T13:00:05.000Z", { 1: 5 })}>
        <DeltaProbe />
      </BoardSourceProvider>,
    );
    expect(readDeltas()).toEqual({});
  });

  it("play forward after a scrub-reset shows cues normally again", () => {
    const { rerender } = renderWithPush(pushAt("9999", "2026-09-08T13:00:10.000Z", { 1: 2 }));
    // Scrub backwards: resets the baseline to position 5 with no cue.
    rerender(
      <BoardSourceProvider push={pushAt("9999", "2026-09-08T13:00:05.000Z", { 1: 5 })}>
        <DeltaProbe />
      </BoardSourceProvider>,
    );
    expect(readDeltas()).toEqual({});
    // Play forward from there: 5 -> 2 is a real, cue-worthy change.
    rerender(
      <BoardSourceProvider push={pushAt("9999", "2026-09-08T13:00:06.000Z", { 1: 2 })}>
        <DeltaProbe />
      </BoardSourceProvider>,
    );
    expect(readDeltas()).toEqual({ 1: 3 });
  });

  it("a cue expires 8s after it was set, checked against Date.now() on the next render", () => {
    const { rerender } = renderWithPush(pushAt("9999", "2026-09-08T13:00:00.000Z", { 1: 3 }));
    rerender(
      <BoardSourceProvider push={pushAt("9999", "2026-09-08T13:00:01.000Z", { 1: 1 })}>
        <DeltaProbe />
      </BoardSourceProvider>,
    );
    expect(readDeltas()).toEqual({ 1: 2 });

    // 7.9s later, unchanged position: the cue is still live.
    vi.setSystemTime(7900);
    rerender(
      <BoardSourceProvider push={pushAt("9999", "2026-09-08T13:00:02.000Z", { 1: 1 })}>
        <DeltaProbe />
      </BoardSourceProvider>,
    );
    expect(readDeltas()).toEqual({ 1: 2 });

    // 8.1s after the cue was set: it has faded.
    vi.setSystemTime(8100);
    rerender(
      <BoardSourceProvider push={pushAt("9999", "2026-09-08T13:00:03.000Z", { 1: 1 })}>
        <DeltaProbe />
      </BoardSourceProvider>,
    );
    expect(readDeltas()).toEqual({});
  });

  it("no delta for a driver whose position did not change", () => {
    const { rerender } = renderWithPush(pushAt("9999", "2026-09-08T13:00:00.000Z", { 1: 1 }));
    rerender(
      <BoardSourceProvider push={pushAt("9999", "2026-09-08T13:00:01.000Z", { 1: 1 })}>
        <DeltaProbe />
      </BoardSourceProvider>,
    );
    expect(readDeltas()).toEqual({});
  });
});
