import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";

import { BoardSourceProvider } from "../board/useBoardState.ts";
import { makePush } from "../test/fixtures.ts";
import { BoardPage } from "./BoardPage.tsx";

function renderWith(push: ReturnType<typeof makePush> | null, toolbar?: React.ReactNode): void {
  render(
    <MemoryRouter>
      <BoardSourceProvider push={push}>
        <BoardPage toolbar={toolbar} />
      </BoardSourceProvider>
    </MemoryRouter>,
  );
}

describe("BoardPage", () => {
  it("composes the lap counter, source clock, cards, and table", () => {
    renderWith(makePush());

    expect(screen.getByText("LAP 12/53")).toBeInTheDocument();
    expect(screen.getByText("13:00:00 UTC")).toBeInTheDocument();
    expect(screen.getByText("Race timing live")).toBeInTheDocument(); // RaceControlCard
    expect(screen.getByText("24.5°C air / 31.2°C track")).toBeInTheDocument(); // WeatherCard
    expect(screen.getByText("2 drivers")).toBeInTheDocument(); // TimingTable
    expect(screen.getByText("VER")).toBeInTheDocument();
  });

  it("renders a toolbar slot for a caller's control", () => {
    renderWith(makePush(), <button type="button">Delay</button>);
    expect(screen.getByRole("button", { name: "Delay" })).toBeInTheDocument();
  });

  it("renders the empty state before any push arrives", () => {
    renderWith(null);
    expect(screen.getByText("LAP —")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument(); // source clock
    expect(screen.getByText("Waiting for race state…")).toBeInTheDocument();
    expect(screen.getByText("0 drivers")).toBeInTheDocument();
  });

  it("shows no banner while the session is live (the default fixture status)", () => {
    renderWith(makePush());
    expect(screen.queryByText(/This race has finished/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Race starts/)).not.toBeInTheDocument();
  });

  it("shows the finished banner with a replay link when the session has finished", () => {
    renderWith(
      makePush({ session_key: "11361" }, { session: { session_key: "11361", name: "Race", country: "Italy", status: "finished" } }),
    );

    expect(screen.getByText("This race has finished. Showing its final state.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Watch the replay" });
    expect(link).toHaveAttribute("href", "/races/11361");
  });

  it("shows the upcoming banner when the session has not started", () => {
    renderWith(
      makePush(
        {},
        { session: { session_key: "11361", name: "Race", country: "Italy", status: "upcoming", date_start: "2026-09-08T12:00:00.000Z" } },
      ),
    );

    expect(screen.getByText("Race starts 2026-09-08. Timing appears when the session goes live.")).toBeInTheDocument();
  });
});
