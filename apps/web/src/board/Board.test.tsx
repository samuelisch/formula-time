// The board composition cases: they exercise the pure board (lap counter,
// clock, cards, table, toolbar slot), `Board`. BoardPage's own tests cover
// only what the live route adds on top.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";

import { makePush } from "../test/fixtures.ts";
import { Board } from "./Board.tsx";
import { BoardSourceProvider } from "./useBoardState.ts";

// Wrapped in a MemoryRouter: TimingTable's rows read/write the driver
// selection via useSearchParams(), which needs a Router context.
function renderWith(
  push: ReturnType<typeof makePush> | null,
  controls?: React.ReactNode,
  transport?: React.ReactNode,
  side?: React.ReactNode,
) {
  return render(
    <MemoryRouter>
      <BoardSourceProvider push={push}>
        <Board controls={controls} transport={transport} side={side} />
      </BoardSourceProvider>
    </MemoryRouter>,
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

  it("renders a side slot for a caller's control (beside the table on wide screens, per Board.module.css)", () => {
    renderWith(makePush(), undefined, undefined, <span>Driver detail</span>);
    expect(screen.getByText("Driver detail")).toBeInTheDocument();
  });

  // The narrow-breakpoint placement: the panel must land "under the
  // toolbar", not after the table. `Board.module.css`
  // achieves the two different visual arrangements (stacked full-width vs.
  // beside the table) from one `grid-template-areas` swap on a single
  // `.board` grid, without ever moving `side` in the DOM -- so the one
  // thing this jsdom test *can* assert (no real CSS layout/media queries
  // here) is that DOM order, which is what makes the narrow layout's
  // default single-column flow put `side` right after the toolbar and
  // before the cards/table in the first place.
  it("keeps the side slot ahead of the cards and the table in DOM order, so the narrow layout needs no extra CSS to land it under the toolbar", () => {
    const { container } = renderWith(makePush(), undefined, undefined, <span>Driver detail</span>);
    const html = container.innerHTML;
    const sideIndex = html.indexOf("Driver detail");
    const cardsIndex = html.indexOf("Race timing live"); // RaceControlCard, in the .grid area
    const tableIndex = html.indexOf("Timing"); // TimingTable's own header

    expect(sideIndex).toBeGreaterThan(-1);
    expect(sideIndex).toBeLessThan(cardsIndex);
    expect(sideIndex).toBeLessThan(tableIndex);
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
