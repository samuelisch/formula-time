import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";

import { makeDriver, makePush } from "../test/fixtures.ts";
import { TimingTable } from "./TimingTable.tsx";
import { BoardSourceProvider } from "./useBoardState.ts";

// Wrapped in a MemoryRouter: DriverRow reads/writes the driver selection
// through useDriverSelection() (useSearchParams), which needs a Router
// context even when a row's click is never simulated.
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

// TimingTable wires useBoardPositionDeltas() to each DriverRow. A single
// render never has a previous push to compare against, so these cases
// render once and then push a second, changed state.
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

  // A row-level highlight is a second signal alongside the arrow/number
  // cue, not a replacement for it.
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

// A leader on lap 5 makes leaderLap() (@formula-time/domain) return 5, which
// runStatus() reads to derive each other driver's status: LEC is 3 laps down
// with a stale intervals timestamp (dnf), ALO has no lap row at all with the
// leader past lap 2 (dns), and HAM is still receiving fresh intervals despite
// a lap-count gap string (running).
function retiredScenarioPush() {
  const leader = makeDriver({
    driver_number: 1,
    name_acronym: "VER",
    position: 1,
    current_lap: 5,
    source_timestamps: { lap: "2026-09-08T13:10:00.000Z" },
  });
  const dnfDriver = makeDriver({
    driver_number: 16,
    name_acronym: "LEC",
    position: 16,
    current_lap: 2,
    source_timestamps: { intervals: "2026-09-08T13:00:00.000Z" },
  });
  const dnsDriver = makeDriver({
    driver_number: 14,
    name_acronym: "ALO",
    position: 17,
    current_lap: null,
  });
  const lappedRunningDriver = makeDriver({
    driver_number: 44,
    name_acronym: "HAM",
    position: 2,
    current_lap: 5,
    gap_to_leader: "+2 LAPS",
  });

  return makePush(
    {},
    {
      drivers: { "1": leader, "16": dnfDriver, "14": dnsDriver, "44": lappedRunningDriver },
      driver_order: [1, 44, 16, 14],
    },
  );
}

describe("TimingTable retired drivers", () => {
  it("renders DNF in the gap and interval cells for a driver 3+ laps down with a stale intervals timestamp", () => {
    renderWith(retiredScenarioPush());
    const row = screen.getByText("LEC").closest("tr")!;
    expect(within(row).getAllByText("DNF")).toHaveLength(2);
  });

  it("renders DNS in the gap and interval cells for a driver with no lap row once the leader has passed lap 2", () => {
    renderWith(retiredScenarioPush());
    const row = screen.getByText("ALO").closest("tr")!;
    expect(within(row).getAllByText("DNS")).toHaveLength(2);
  });

  it("still shows a lap-count gap for a running driver who is laps down but still receiving updates", () => {
    renderWith(retiredScenarioPush());
    expect(screen.getByText("+2 LAPS")).toBeInTheDocument();
  });

  it("mutes a retired row's class", () => {
    renderWith(retiredScenarioPush());
    const dnfRow = screen.getByText("LEC").closest("tr")!;
    const dnsRow = screen.getByText("ALO").closest("tr")!;
    expect(dnfRow.className).toMatch(/retired/);
    expect(dnsRow.className).toMatch(/retired/);
  });

  it("renders no position-change cue for a retired row even after a position change", () => {
    // driver_order stays put -- its first entry is also leaderLap()'s leader
    // (@formula-time/domain), so only LEC's own `position` field changes
    // here, leaving the dnf/dns basis (the leader's current_lap) untouched.
    const first = retiredScenarioPush();
    const { rerender } = renderWith(first);
    const second = retiredScenarioPush();
    second.state.drivers["16"] = { ...second.state.drivers["16"]!, position: 1 };
    rerender(tree(second));
    const row = screen.getByText("LEC").closest("tr")!;
    expect(within(row).queryByText(/^[▲▼]/)).not.toBeInTheDocument();
    expect(row.className).not.toMatch(/rowGain|rowLoss/);
  });
});
