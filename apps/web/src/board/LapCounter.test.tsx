import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makePush } from "../test/fixtures.ts";
import { LapCounter } from "./LapCounter.tsx";
import { BoardSourceProvider } from "./useBoardState.ts";

function renderWith(push: ReturnType<typeof makePush> | null): void {
  render(
    <BoardSourceProvider push={push}>
      <LapCounter />
    </BoardSourceProvider>,
  );
}

describe("LapCounter", () => {
  it("shows LAP — when the leader has not started a lap yet", () => {
    renderWith(makePush({}, { driver_order: [], drivers: {} }));
    expect(screen.getByText("LAP —")).toBeInTheDocument();
  });

  it("shows LAP {n} without a total when total_laps is unknown", () => {
    renderWith(makePush({ total_laps: null }));
    expect(screen.getByText("LAP 12")).toBeInTheDocument();
  });

  it("shows LAP {n}/{total} once both are known", () => {
    renderWith(makePush({ total_laps: 53 }));
    expect(screen.getByText("LAP 12/53")).toBeInTheDocument();
  });
});
