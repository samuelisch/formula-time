import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makePush } from "../test/fixtures.ts";
import { RaceControlFeed } from "./RaceControlFeed.tsx";
import { BoardSourceProvider } from "./useBoardState.ts";

function renderWith(
  recentMessages: Array<{ event_id: string; payload: Record<string, unknown> }>,
  defaultOpen: boolean = false,
): void {
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
            recent_messages: recentMessages,
          },
        },
      )}
    >
      <RaceControlFeed defaultOpen={defaultOpen} />
    </BoardSourceProvider>,
  );
}

const yellowFlag = {
  date: "2026-09-08T13:05:10.000Z",
  category: "Flag",
  flag: "YELLOW",
  scope: "Sector",
  sector: 4,
  message: "YELLOW IN SECTOR 4",
};

const pitMessage = {
  date: "2026-09-08T13:10:22.000Z",
  category: "Other",
  message: "CAR 44 PIT ENTRY",
  driver_number: 44,
  lap_number: 12,
};

const safetyCarMessage = {
  date: "2026-09-08T13:12:00.000Z",
  category: "SafetyCar",
  message: "SAFETY CAR DEPLOYED",
};

describe("RaceControlFeed", () => {
  it("shows the empty state when there are no messages yet", () => {
    renderWith([]);
    expect(screen.getByText("No race-control messages yet")).toBeInTheDocument();
    expect(screen.getByText("Race control · 0 messages")).toBeInTheDocument();
  });

  it("lists messages newest first", () => {
    renderWith(
      [
        { event_id: "e1", payload: yellowFlag },
        { event_id: "e2", payload: pitMessage },
        { event_id: "e3", payload: safetyCarMessage },
      ],
      true,
    );

    const rows = screen.getAllByRole("listitem");
    const times = rows.map((row) => within(row).getByText(/UTC$/).textContent);
    expect(times).toEqual(["13:12:00 UTC", "13:10:22 UTC", "13:05:10 UTC"]);
  });

  it("renders time, category, message, flag/scope, driver number, and lap when present", () => {
    renderWith([{ event_id: "e1", payload: yellowFlag }]);

    expect(screen.getByText("13:05:10 UTC")).toBeInTheDocument();
    expect(screen.getByText("Flag")).toBeInTheDocument();
    expect(screen.getByText("YELLOW IN SECTOR 4")).toBeInTheDocument();
    expect(screen.getByText("YELLOW · Sector 4")).toBeInTheDocument();
  });

  it("renders driver number and lap for a message that carries them", () => {
    renderWith([{ event_id: "e1", payload: pitMessage }]);

    expect(screen.getByText("#44 · Lap 12")).toBeInTheDocument();
  });

  it("bolds SafetyCar rows", () => {
    renderWith([{ event_id: "e1", payload: safetyCarMessage }]);

    const row = screen.getByText("SAFETY CAR DEPLOYED").closest("li");
    expect(row?.className).toMatch(/safetyCar/);
  });

  it("shows the summary with count and the last message's time", () => {
    renderWith([
      { event_id: "e1", payload: yellowFlag },
      { event_id: "e2", payload: safetyCarMessage },
    ]);

    expect(screen.getByText("Race control · 2 messages · last 13:12:00 UTC")).toBeInTheDocument();
  });

  it("defaults collapsed when defaultOpen is not passed", () => {
    renderWith([{ event_id: "e1", payload: pitMessage }]);
    expect(screen.getByText("CAR 44 PIT ENTRY")).not.toBeVisible();
  });

  it("defaults expanded when defaultOpen is true (replay)", () => {
    renderWith([{ event_id: "e1", payload: pitMessage }], true);
    expect(screen.getByText("CAR 44 PIT ENTRY")).toBeVisible();
  });

  it("keys rows by event_id", () => {
    renderWith([
      { event_id: "e1", payload: yellowFlag },
      { event_id: "e2", payload: safetyCarMessage },
    ], true);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
