import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";

import { makeDriver, makePush } from "../test/fixtures.ts";
import { DriverPanel } from "./DriverPanel.tsx";
import { BoardSourceProvider } from "./useBoardState.ts";

function renderWith(push: ReturnType<typeof makePush> | null, path = "/live?driver=1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BoardSourceProvider push={push}>
        <DriverPanel />
      </BoardSourceProvider>
    </MemoryRouter>,
  );
}

describe("DriverPanel", () => {
  it("renders nothing when no driver is selected", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/live"]}>
        <BoardSourceProvider push={makePush()}>
          <DriverPanel />
        </BoardSourceProvider>
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the selected driver is not in the current push", () => {
    const { container } = renderWith(makePush(), "/live?driver=999");
    expect(container).toBeEmptyDOMElement();
  });

  it("renders every field for the leader (driver 1, VER)", () => {
    renderWith(makePush());

    expect(screen.getByText("VER")).toBeInTheDocument();
    expect(screen.getByText("Max Verstappen")).toBeInTheDocument();
    expect(screen.getByText("Red Bull Racing")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument(); // position
    expect(screen.getByText("12/53")).toBeInTheDocument(); // current lap / total laps (makePush's total_laps)
    expect(screen.getByText("MEDIUM")).toBeInTheDocument(); // tyre compound
    expect(screen.getByText("2")).toBeInTheDocument(); // stint number
    expect(screen.getByText("8")).toBeInTheDocument(); // tyre lap started
    expect(screen.getByText("4")).toBeInTheDocument(); // tyre age
    expect(screen.getByText("L7 · 2.4s")).toBeInTheDocument(); // the one pit stop, from latest_pit_stop-shaped fixture data
  });

  // Fix round 1: gap/interval rendered "—s" (a literal "s" appended outside
  // number()'s own fallback) for a null value instead of the issue's
  // verbatim "missing values render —". VER (the fixture's leader) has a
  // null gap_to_leader and interval, so this is the case that must not
  // regress.
  it("renders the em dash, not '—s', for the leader's null gap and interval", () => {
    renderWith(makePush());

    expect(screen.queryByText("—s")).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2); // gap and interval
  });

  it("renders em dashes for fields the fixture leaves null (Hamilton: no laps/sectors/pit-out/pit stops yet)", () => {
    renderWith(makePush(), "/live?driver=44");

    expect(screen.getByText("HAM")).toBeInTheDocument();
    expect(screen.getByText("2.567s")).toBeInTheDocument(); // gap
    expect(screen.getByText("1.234s")).toBeInTheDocument(); // interval
    expect(screen.getByText("No pit stops yet.")).toBeInTheDocument();
    // last lap, three sectors, and pit-out-lap all render the em dash fallback.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });

  it("renders a lapped gap as its own string, not a number with a unit", () => {
    const driver = makeDriver({ driver_number: 77, name_acronym: "BOT", gap_to_leader: "+2 LAPS" });
    renderWith(makePush({}, { drivers: { "77": driver }, driver_order: [77] }), "/live?driver=77");

    expect(screen.getByText("+2 LAPS")).toBeInTheDocument();
  });

  it("orders pit stops newest first", () => {
    const driver = makeDriver({
      driver_number: 7,
      name_acronym: "XYZ",
      pit_stops: [
        { lap_number: 5, pit_duration: 2.1 },
        { lap_number: 20, pit_duration: 3.4 },
      ],
    });
    renderWith(makePush({}, { drivers: { "7": driver }, driver_order: [7] }), "/live?driver=7");

    const items = screen.getAllByRole("listitem").map((el) => el.textContent);
    expect(items).toEqual(["L20 · 3.4s", "L5 · 2.1s"]);
  });
});
