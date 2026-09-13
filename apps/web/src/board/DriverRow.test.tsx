import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makePush } from "../test/fixtures.ts";
import { DriverRow } from "./DriverRow.tsx";
import { BoardSourceProvider } from "./useBoardState.ts";

function renderRow(onSelect: (driverNumber: number) => void, selected = false) {
  return render(
    <BoardSourceProvider push={makePush()}>
      <table>
        <tbody>
          <DriverRow number={1} selected={selected} onSelect={onSelect} />
        </tbody>
      </table>
    </BoardSourceProvider>,
  );
}

describe("DriverRow keyboard access", () => {
  it("puts the driver's name in a button reachable by Tab", async () => {
    const user = userEvent.setup();
    renderRow(vi.fn());

    await user.tab();

    expect(screen.getByRole("button", { name: /Max Verstappen/ })).toHaveFocus();
  });

  it("selects the driver on Enter, same as a click", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderRow(onSelect);

    await user.tab();
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("reflects selection state on the button's aria-pressed", () => {
    renderRow(vi.fn(), true);
    expect(screen.getByRole("button", { name: /Max Verstappen/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not mark the row itself selected -- aria-selected is not valid on a tr outside a grid", () => {
    renderRow(vi.fn(), true);
    const row = screen.getByRole("button", { name: /Max Verstappen/ }).closest("tr")!;
    expect(row).not.toHaveAttribute("aria-selected");
  });
});
