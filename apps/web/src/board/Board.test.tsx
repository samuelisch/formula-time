// The board composition cases that used to live in pages/BoardPage.test.tsx:
// they exercise the pure board (lap counter, clock, cards, table, toolbar
// slot), which is `Board` since issue #57 fix round 5. BoardPage's own tests
// now cover only what the live route adds on top.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makePush } from "../test/fixtures.ts";
import { Board } from "./Board.tsx";
import { BoardSourceProvider } from "./useBoardState.ts";

function renderWith(
  push: ReturnType<typeof makePush> | null,
  controls?: React.ReactNode,
  transport?: React.ReactNode,
): void {
  render(
    <BoardSourceProvider push={push}>
      <Board controls={controls} transport={transport} />
    </BoardSourceProvider>,
  );
}

describe("Board", () => {
  it("composes the lap counter, source clock, cards, and table", () => {
    renderWith(makePush());

    expect(screen.getByText("LAP 12/53")).toBeInTheDocument();
    expect(screen.getByText("13:00:00 UTC")).toBeInTheDocument();
    expect(screen.getByText("Race timing live")).toBeInTheDocument(); // RaceControlCard
    expect(screen.getByText("24.5°C air / 31.2°C track")).toBeInTheDocument(); // WeatherCard
    expect(screen.getByText("2 drivers")).toBeInTheDocument(); // TimingTable
    expect(screen.getByText("VER")).toBeInTheDocument();
  });

  it("renders a controls slot (row 1) and a transport slot (row 2, full width) for the caller's controls", () => {
    renderWith(makePush(), <button type="button">Align</button>, <button type="button">Bar</button>);
    expect(screen.getByRole("button", { name: "Align" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bar" })).toBeInTheDocument();
  });

  it("renders the empty state before any push arrives", () => {
    renderWith(null);
    expect(screen.getByText("LAP —")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument(); // source clock
    expect(screen.getByText("Waiting for race state…")).toBeInTheDocument();
    expect(screen.getByText("0 drivers")).toBeInTheDocument();
  });

  // The point of the split: nothing live-only is reachable from here, so a
  // replay mounting `Board` cannot pick up the finished-session banner, the
  // polls button, or the delay/align controls (all of which read the live
  // session and live store).
  it("renders no session banner, poll button, or alignment control of its own", () => {
    renderWith(makePush({}, { session: { session_key: "11361", name: "Race", country: "Italy", status: "finished" } }));

    expect(screen.queryByText(/This race has finished/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Polls/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Live" })).not.toBeInTheDocument(); // DelayControl
    expect(screen.queryByRole("button", { name: /Align with my screen/ })).not.toBeInTheDocument();
  });
});
