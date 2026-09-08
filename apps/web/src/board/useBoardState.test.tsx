import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useLiveStore } from "../live/store.ts";
import { makePush } from "../test/fixtures.ts";
import {
  BoardSourceProvider,
  useBoardDriver,
  useBoardDriverOrder,
  useBoardLeaderLap,
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
