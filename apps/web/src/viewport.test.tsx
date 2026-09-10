// The phone-width responsive pass (apps/web/AGENTS.md): a pure CSS
// collapse needs no pixel measurement here -- jsdom does not apply
// stylesheet rules -- but the elements a narrow media query targets must
// carry the class (or be hidden) that query relies on, so a future
// refactor that drops the class is caught here rather than only in a
// browser. Cases render under the narrow matchMedia stub
// (src/test/matchMedia.ts) and assert class names, not pixels.
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";

import { BoardSourceProvider } from "./board/useBoardState.ts";
import { TimingTable } from "./board/TimingTable.tsx";
import { makeDriver, makePush } from "./test/fixtures.ts";
import { installNarrowMatchMedia } from "./test/matchMedia.ts";
import { TimeTargetProvider, type TimeTarget } from "./transport/TimeTarget.ts";
import { TransportBar } from "./transport/TransportBar.tsx";

describe("TimingTable under a narrow viewport", () => {
  let stub: { restore: () => void };

  beforeEach(() => {
    stub = installNarrowMatchMedia(true);
  });

  afterEach(() => {
    stub.restore();
  });

  it("marks the driver full name and the team name for the narrow-width collapse", () => {
    const driver = makeDriver({
      driver_number: 1,
      name_acronym: "VER",
      full_name: "Max Verstappen",
      team_name: "Red Bull Racing",
      position: 1,
    });
    render(
      <MemoryRouter>
        <BoardSourceProvider push={makePush({}, { drivers: { "1": driver }, driver_order: [1] })}>
          <TimingTable />
        </BoardSourceProvider>
      </MemoryRouter>,
    );

    const fullName = screen.getByText("Max Verstappen");
    const teamName = screen.getByText("Red Bull Racing");
    // TimingTable.module.css hides both under --bp-narrow (640px) -- these
    // classes are what that media query selects.
    expect(fullName.className).toMatch(/fullName/);
    expect(teamName.className).toMatch(/teamName/);
  });
});

describe("TransportBar under a narrow viewport", () => {
  let stub: { restore: () => void };

  const target: TimeTarget = {
    displayedAt: () => 0,
    seekTo: () => {},
    nudge: () => {},
    anchors: () => ({ lights_out: null, laps: [], restarts: [] }),
    range: () => ({ startMs: 0, endMs: 180_000 }),
    playback: () => null,
    notice: () => null,
    syncOffsetMs: () => 0,
    rewindMode: () => "buffer",
  };

  beforeEach(() => {
    stub = installNarrowMatchMedia(true);
  });

  afterEach(() => {
    stub.restore();
  });

  it("marks every button and the lap-jump input for the 40px tap target", () => {
    render(
      <TimeTargetProvider value={target}>
        <TransportBar />
      </TimeTargetProvider>,
    );

    // TransportBar.module.css grows `.control` to a 40px min-height under
    // --bp-narrow -- every plain button and the lap input carry it.
    const buttons = ["−10s", "−5s", "Live", "+5s", "+10s", "Race start", "Go"].map((name) =>
      screen.getByRole("button", { name }),
    );
    for (const button of buttons) {
      expect(button.className).toMatch(/control/);
    }
    expect(screen.getByLabelText("Lap number").className).toMatch(/control/);
  });
});
