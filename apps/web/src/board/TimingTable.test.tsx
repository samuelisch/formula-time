import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";

import { makeDriver, makePush } from "../test/fixtures.ts";
import { TimingTable } from "./TimingTable.tsx";
import { BoardSourceProvider } from "./useBoardState.ts";

// Wrapped in a MemoryRouter: DriverRow reads/writes the driver selection
// through useDriverSelection() (useSearchParams), which needs a Router
// context even when a row's click is never simulated (issue #90).
function tree(push: ReturnType<typeof makePush> | null) {
  return (
    <MemoryRouter>
      <BoardSourceProvider push={push}>
        <TimingTable />
      </BoardSourceProvider>
    </MemoryRouter>
  );
}

function renderWith(push: ReturnType<typeof makePush> | null) {
  return render(tree(push));
}

describe("TimingTable ordering", () => {
  it("orders driver_order first, then unpositioned drivers by driver number", () => {
    const leader = makeDriver({ driver_number: 1, name_acronym: "VER", position: 1 });
    const second = makeDriver({ driver_number: 44, name_acronym: "HAM", position: 2 });
    const unpositionedHigh = makeDriver({ driver_number: 99, name_acronym: "ZZZ", position: null });
    const unpositionedLow = makeDriver({ driver_number: 3, name_acronym: "AAA", position: null });

    renderWith(
      makePush(
        {},
        {
          drivers: { "1": leader, "44": second, "99": unpositionedHigh, "3": unpositionedLow },
          driver_order: [1, 44],
        },
      ),
    );

    const acronyms = screen.getAllByText(/^(VER|HAM|ZZZ|AAA)$/).map((el) => el.textContent);
    expect(acronyms).toEqual(["VER", "HAM", "AAA", "ZZZ"]);
  });

  it("shows the waiting empty state and a 0 drivers count with no drivers", () => {
    renderWith(makePush({}, { drivers: {}, driver_order: [] }));
    expect(screen.getByText("Waiting for race state…")).toBeInTheDocument();
    expect(screen.getByText("0 drivers")).toBeInTheDocument();
  });

  it("shows the driver count", () => {
    renderWith(makePush());
    expect(screen.getByText("2 drivers")).toBeInTheDocument();
  });
});

describe("TimingTable row formatting", () => {
  it("renders position, driver identity, team, gap, interval, tyre, and last pit", () => {
    renderWith(makePush());

    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("VER")).toBeInTheDocument();
    expect(screen.getByText("Max Verstappen")).toBeInTheDocument();
    expect(screen.getByText("Red Bull Racing")).toBeInTheDocument();
    expect(screen.getByText("2.567s")).toBeInTheDocument(); // Hamilton's gap to leader
    expect(screen.getByText("1.234s")).toBeInTheDocument(); // Hamilton's interval
    expect(screen.getByText("MEDIUM · age 4")).toBeInTheDocument();
    expect(screen.getByText("L7 · 2.4s")).toBeInTheDocument(); // Verstappen's latest pit stop
  });

  it("shows em dashes for an unpositioned driver with no gap, tyre, or pit data", () => {
    const driver = makeDriver({ driver_number: 7, name_acronym: "XYZ", position: null });
    renderWith(makePush({}, { drivers: { "7": driver }, driver_order: [] }));

    expect(screen.getByText("XYZ")).toBeInTheDocument();
    expect(screen.queryByText("—s")).not.toBeInTheDocument();
    // position, full name, team name, gap, interval, tyre, and last pit all fall back to "—"
    expect(screen.getAllByText("—")).toHaveLength(7);
  });

  it("renders a lapped gap as its own string, not a number with a unit", () => {
    const driver = makeDriver({ driver_number: 16, name_acronym: "LEC", position: 5, gap_to_leader: "+1 LAP" });
    renderWith(makePush({}, { drivers: { "16": driver }, driver_order: [16] }));

    expect(screen.getByText("+1 LAP")).toBeInTheDocument();
  });
});

// TimingTable wires useBoardPositionDeltas() (issue #91) to each DriverRow.
// A single render never has a previous push to compare against, so these
// cases render once and then push a second, changed state.
describe("TimingTable position cues", () => {
  function pushWithPosition(position: number) {
    const driver = makeDriver({ driver_number: 1, name_acronym: "VER", position });
    return makePush({}, { drivers: { "1": driver }, driver_order: [1] });
  }

  it("renders a gain cue for a driver who moved up since the previous push", () => {
    const { rerender } = renderWith(pushWithPosition(3));
    rerender(tree(pushWithPosition(1)));
    expect(screen.getByText("▲ 2")).toBeInTheDocument();
  });

  it("renders a loss cue for a driver who moved down since the previous push", () => {
    const { rerender } = renderWith(pushWithPosition(1));
    rerender(tree(pushWithPosition(4)));
    expect(screen.getByText("▼ 3")).toBeInTheDocument();
  });

  it("renders no cue text for a driver whose position did not change", () => {
    const { rerender } = renderWith(pushWithPosition(2));
    rerender(tree(pushWithPosition(2)));
    expect(screen.queryByText(/^[▲▼]/)).not.toBeInTheDocument();
  });

  // Fix round 1 (issue #91 review): the issue asks for the arrow/number cue
  // "plus a subtle row highlight on the change" -- a second, row-level
  // signal, not only the small cell.
  it("adds a row-highlight class on a position change", () => {
    const { rerender } = renderWith(pushWithPosition(3));
    rerender(tree(pushWithPosition(1)));
    const row = screen.getByText("VER").closest("tr")!;
    expect(row.className).toMatch(/rowGain/);
  });

  it("adds no row-highlight class for a driver whose position never changed", () => {
    // A fresh render (not a rerender after a real change), so there is
    // nothing in useBoardPositionDeltas()'s baseline for this to compare
    // against yet -- unlike a same-position rerender right after a real
    // gain/loss, whose cue is still within its 8s window and correctly
    // still highlighted.
    renderWith(pushWithPosition(2));
    const row = screen.getByText("VER").closest("tr")!;
    expect(row.className).not.toMatch(/rowGain|rowLoss/);
  });
});
