import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makePush } from "../test/fixtures.ts";
import { RaceControlCard } from "./RaceControlCard.tsx";
import { BoardSourceProvider } from "./useBoardState.ts";

function renderWith(push: ReturnType<typeof makePush> | null): void {
  render(
    <BoardSourceProvider push={push}>
      <RaceControlCard />
    </BoardSourceProvider>,
  );
}

describe("RaceControlCard phase line", () => {
  it("shows Pre-race before any session status arrives", () => {
    renderWith(makePush({}, { race_control: { session_status: null, current_flag: null, safety_car: null, active_flags: {}, driver_flags: {}, recent_messages: [] } }));
    expect(screen.getByText("Pre-race · waiting for timing data")).toBeInTheDocument();
  });

  it("shows Session started while the session has started but no drivers have arrived", () => {
    renderWith(
      makePush(
        {},
        {
          drivers: {},
          driver_order: [],
          race_control: { session_status: "SESSION STARTED", current_flag: null, safety_car: null, active_flags: {}, driver_flags: {}, recent_messages: [] },
        },
      ),
    );
    expect(screen.getByText("Session started · waiting for live timing")).toBeInTheDocument();
  });

  it("shows Race timing live once the session has started with drivers present", () => {
    renderWith(makePush());
    expect(screen.getByText("Race timing live")).toBeInTheDocument();
  });

  it("shows the status verbatim for any other status", () => {
    renderWith(
      makePush(
        {},
        { race_control: { session_status: "SESSION FINISHED", current_flag: null, safety_car: null, active_flags: {}, driver_flags: {}, recent_messages: [] } },
      ),
    );
    expect(screen.getByText("SESSION FINISHED")).toBeInTheDocument();
  });
});

describe("RaceControlCard flag line", () => {
  it("shows No active flag when nothing is set", () => {
    renderWith(makePush());
    expect(screen.getByText("No active flag")).toBeInTheDocument();
  });

  it("shows a full safety car deployment", () => {
    renderWith(
      makePush({}, { race_control: { session_status: "SESSION STARTED", current_flag: null, safety_car: "SC", active_flags: {}, driver_flags: {}, recent_messages: [] } }),
    );
    expect(screen.getByText("Safety Car (SC)")).toBeInTheDocument();
  });

  it("shows a virtual safety car deployment", () => {
    renderWith(
      makePush({}, { race_control: { session_status: "SESSION STARTED", current_flag: null, safety_car: "VSC", active_flags: {}, driver_flags: {}, recent_messages: [] } }),
    );
    expect(screen.getByText("Virtual Safety Car (VSC)")).toBeInTheDocument();
  });

  it("joins active_flags as scope: flag and driver_flags as #num: flag", () => {
    renderWith(
      makePush(
        {},
        {
          race_control: {
            session_status: "SESSION STARTED",
            current_flag: "YELLOW",
            safety_car: null,
            active_flags: { Track: "YELLOW" },
            driver_flags: { "44": "BLACK AND WHITE" },
            recent_messages: [],
          },
        },
      ),
    );
    expect(screen.getByText("Track: YELLOW · #44: BLACK AND WHITE")).toBeInTheDocument();
  });
});
