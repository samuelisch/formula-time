import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Collapsible } from "./Collapsible.tsx";

describe("Collapsible", () => {
  it("starts closed by default and opens on click", async () => {
    const user = userEvent.setup();
    render(
      <Collapsible summary="Summary line">
        <p>Body content</p>
      </Collapsible>,
    );

    expect(screen.getByText("Body content")).not.toBeVisible();

    await user.click(screen.getByRole("button", { name: "Summary line" }));

    expect(screen.getByText("Body content")).toBeVisible();
  });

  it("starts open when defaultOpen is true, and closes on click", async () => {
    const user = userEvent.setup();
    render(
      <Collapsible summary="Summary line" defaultOpen>
        <p>Body content</p>
      </Collapsible>,
    );

    expect(screen.getByText("Body content")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Summary line" }));

    expect(screen.getByText("Body content")).not.toBeVisible();
  });

  it("reflects state in aria-expanded and aria-controls", async () => {
    const user = userEvent.setup();
    render(
      <Collapsible summary="Summary line">
        <p>Body content</p>
      </Collapsible>,
    );

    const trigger = screen.getByRole("button", { name: "Summary line" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const controlsId = trigger.getAttribute("aria-controls");
    expect(controlsId).not.toBeNull();
    expect(screen.getByText("Body content").closest(`#${controlsId}`)).not.toBeNull();
  });

  it("is keyboard operable: Enter and Space both toggle", async () => {
    const user = userEvent.setup();
    render(
      <Collapsible summary="Summary line">
        <p>Body content</p>
      </Collapsible>,
    );

    await user.tab();
    const trigger = screen.getByRole("button", { name: "Summary line" });
    expect(trigger).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByText("Body content")).toBeVisible();

    await user.keyboard(" ");
    expect(screen.getByText("Body content")).not.toBeVisible();
  });

  it("is controlled when open/onToggle are provided: a click calls onToggle rather than flipping internal state", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <Collapsible summary="Summary line" open={false} onToggle={onToggle}>
        <p>Body content</p>
      </Collapsible>,
    );

    await user.click(screen.getByRole("button", { name: "Summary line" }));

    expect(onToggle).toHaveBeenCalledWith(true);
    // Still closed: the parent hasn't re-rendered with open=true yet.
    expect(screen.getByText("Body content")).not.toBeVisible();

    rerender(
      <Collapsible summary="Summary line" open={true} onToggle={onToggle}>
        <p>Body content</p>
      </Collapsible>,
    );

    expect(screen.getByText("Body content")).toBeVisible();
  });
});
