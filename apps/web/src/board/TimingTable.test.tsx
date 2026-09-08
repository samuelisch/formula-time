import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeDriver, makePush } from "../test/fixtures.ts";
import { TimingTable } from "./TimingTable.tsx";
import { BoardSourceProvider } from "./useBoardState.ts";

function renderWith(push: ReturnType<typeof makePush> | null): void {
  render(
    <BoardSourceProvider push={push}>
      <TimingTable />
    </BoardSourceProvider>,
  );
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
    expect(screen.getAllByText("—s")).toHaveLength(2); // gap and interval
    // position, full name, team name, tyre, and last pit all fall back to "—"
    expect(screen.getAllByText("—")).toHaveLength(5);
  });
});
