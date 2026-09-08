import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BoardSourceProvider } from "../board/useBoardState.ts";
import { makePush } from "../test/fixtures.ts";
import { BoardPage } from "./BoardPage.tsx";

function renderWith(push: ReturnType<typeof makePush> | null, toolbar?: React.ReactNode): void {
  render(
    <BoardSourceProvider push={push}>
      <BoardPage toolbar={toolbar} />
    </BoardSourceProvider>,
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
});
