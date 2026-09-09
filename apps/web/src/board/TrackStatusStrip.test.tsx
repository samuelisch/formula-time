import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makePush } from "../test/fixtures.ts";
import { TrackStatusStrip } from "./TrackStatusStrip.tsx";
import { BoardSourceProvider } from "./useBoardState.ts";

function renderWith(raceControlOverrides: Partial<ReturnType<typeof makePush>["state"]["race_control"]>): void {
  render(
    <BoardSourceProvider
      push={makePush(
        {},
        {
          race_control: {
            session_status: "SESSION STARTED",
            current_flag: null,
            safety_car: null,
            active_flags: {},
            driver_flags: {},
            recent_messages: [],
            ...raceControlOverrides,
          },
        },
      )}
    >
      <TrackStatusStrip />
    </BoardSourceProvider>,
  );
}

describe("TrackStatusStrip", () => {
  it("renders nothing when the track is clear", () => {
    const { container } = render(
      <BoardSourceProvider push={makePush()}>
        <TrackStatusStrip />
      </BoardSourceProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing before any push arrives", () => {
    const { container } = render(
      <BoardSourceProvider push={null}>
        <TrackStatusStrip />
      </BoardSourceProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows RED FLAG when a RED active flag is present", () => {
    renderWith({ current_flag: "RED", active_flags: { Track: "RED" } });
    expect(screen.getByText("RED FLAG")).toBeInTheDocument();
  });

  it("shows SAFETY CAR when safety_car is SC", () => {
    renderWith({ safety_car: "SC" });
    expect(screen.getByText("SAFETY CAR")).toBeInTheDocument();
  });

  it("shows VIRTUAL SAFETY CAR when safety_car is VSC", () => {
    renderWith({ safety_car: "VSC" });
    expect(screen.getByText("VIRTUAL SAFETY CAR")).toBeInTheDocument();
  });

  it("shows CHEQUERED FLAG once the race clock reads chequered", () => {
    renderWith({ current_flag: "CHEQUERED", active_flags: { Track: "CHEQUERED" } });
    expect(screen.getByText("CHEQUERED FLAG")).toBeInTheDocument();
  });

  it("shows YELLOW with the formatted sector list, joining scope:sector as 'scope sector'", () => {
    renderWith({ current_flag: "YELLOW", active_flags: { Track: "YELLOW", "Sector:4": "YELLOW" } });
    expect(screen.getByText("YELLOW · sectors Track, Sector 4")).toBeInTheDocument();
  });

  it("prioritises RED over YELLOW when both are active", () => {
    renderWith({ current_flag: "RED", active_flags: { Track: "RED", "Sector:2": "YELLOW" } });
    expect(screen.getByText("RED FLAG")).toBeInTheDocument();
    expect(screen.queryByText(/YELLOW/)).not.toBeInTheDocument();
  });

  it("prioritises SAFETY CAR over YELLOW", () => {
    renderWith({ safety_car: "SC", active_flags: { Track: "YELLOW" } });
    expect(screen.getByText("SAFETY CAR")).toBeInTheDocument();
    expect(screen.queryByText(/YELLOW/)).not.toBeInTheDocument();
  });

  it("prioritises VIRTUAL SAFETY CAR over CHEQUERED", () => {
    renderWith({ safety_car: "VSC", current_flag: "CHEQUERED", active_flags: { Track: "CHEQUERED" } });
    expect(screen.getByText("VIRTUAL SAFETY CAR")).toBeInTheDocument();
    expect(screen.queryByText("CHEQUERED FLAG")).not.toBeInTheDocument();
  });

  it("prioritises CHEQUERED FLAG over YELLOW", () => {
    renderWith({ current_flag: "CHEQUERED", active_flags: { Track: "CHEQUERED", "Sector:1": "YELLOW" } });
    expect(screen.getByText("CHEQUERED FLAG")).toBeInTheDocument();
    expect(screen.queryByText(/YELLOW/)).not.toBeInTheDocument();
  });

  it("prioritises RED over SAFETY CAR", () => {
    renderWith({ safety_car: "SC", current_flag: "RED", active_flags: { Track: "RED" } });
    expect(screen.getByText("RED FLAG")).toBeInTheDocument();
    expect(screen.queryByText("SAFETY CAR")).not.toBeInTheDocument();
  });
});
