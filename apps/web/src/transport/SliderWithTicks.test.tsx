// The snap/label math (`snapTarget`, `currentLap`) is unit tested on its
// own in `sliderMath.test.ts`; this file covers the component's own
// rendering and wiring.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TickMark } from "./sliderMath.ts";
import { SliderWithTicks } from "./SliderWithTicks.tsx";

const TICKS: TickMark[] = [
  { lap: 1, value: 0 },
  { lap: 2, value: 30_000 },
  { lap: 3, value: 60_000 },
  { lap: 4, value: 90_000 },
  { lap: 5, value: 100_000 },
];

describe("SliderWithTicks", () => {
  it("renders one tick per anchor, positioned by percent of the range", () => {
    const { container } = render(
      <SliderWithTicks min={0} max={100_000} value={0} ticks={TICKS} ariaLabel="Playback position" onChange={vi.fn()} />,
    );
    const ticks = Array.from(container.querySelectorAll('[class*="tick"]:not([class*="tickLabel"])'));
    // 5 tick marks (the wrapper's own track children), each positioned via inline `left`.
    expect(ticks.length).toBeGreaterThanOrEqual(TICKS.length);
    const lap3 = ticks.find((el) => (el as HTMLElement).style.left === "60%");
    expect(lap3).toBeDefined();
  });

  it("labels only lap numbers that are multiples of 5", () => {
    render(<SliderWithTicks min={0} max={100_000} value={0} ticks={TICKS} ariaLabel="Playback position" onChange={vi.fn()} />);
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.queryByText("1")).not.toBeInTheDocument();
    expect(screen.queryByText("2")).not.toBeInTheDocument();
    expect(screen.queryByText("3")).not.toBeInTheDocument();
    expect(screen.queryByText("4")).not.toBeInTheDocument();
  });

  it("shows the current lap in a tooltip above the thumb", () => {
    render(<SliderWithTicks min={0} max={100_000} value={45_000} ticks={TICKS} ariaLabel="Playback position" onChange={vi.fn()} />);
    expect(screen.getByText("Lap 2")).toBeInTheDocument();
  });

  it("snaps the emitted value when a pointer drag lands within the threshold of a tick", () => {
    const onChange = vi.fn();
    render(<SliderWithTicks min={0} max={100_000} value={0} ticks={TICKS} ariaLabel="Playback position" onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Playback position" });
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "31000" } });
    expect(onChange).toHaveBeenCalledWith(30_000);
  });

  it("passes the raw value through during a drag when nothing is close enough to snap to", () => {
    const onChange = vi.fn();
    render(<SliderWithTicks min={0} max={100_000} value={0} ticks={TICKS} ariaLabel="Playback position" onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Playback position" });
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "45000" } });
    expect(onChange).toHaveBeenCalledWith(45_000);
  });

  // Fix round 1 on PR #106: the native `step` (100ms) fires a plain
  // `change` event on every arrow-key press too, with no pointerdown --
  // snapping unconditionally there pulled a keyboard step onto a tick not
  // on the 100ms grid, and the control could appear stuck on it.
  it("does not snap a change with no pointer drag in progress, even inside the snap threshold", () => {
    const onChange = vi.fn();
    render(<SliderWithTicks min={0} max={100_000} value={0} ticks={TICKS} ariaLabel="Playback position" onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Playback position" });
    fireEvent.change(slider, { target: { value: "31000" } }); // no pointerDown first
    expect(onChange).toHaveBeenCalledWith(31_000); // not 30_000
  });

  it("keyboard stepping near an off-grid tick moves exactly one step, never snapping onto it", () => {
    const onChange = vi.fn();
    const offGridTick: TickMark[] = [{ lap: 2, value: 30_050 }]; // not a multiple of the 100ms step
    render(<SliderWithTicks min={0} max={100_000} value={29_900} ticks={offGridTick} ariaLabel="Playback position" onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Playback position" });
    // One native step (100ms) lands at 30_000, well within +/-1.5% (1500ms)
    // of the tick at 30_050 -- must not snap without a drag.
    fireEvent.change(slider, { target: { value: "30000" } });
    expect(onChange).toHaveBeenCalledWith(30_000);
    onChange.mockClear();
    fireEvent.change(slider, { target: { value: "30100" } });
    expect(onChange).toHaveBeenCalledWith(30_100);
  });

  it("resumes snapping on a later drag after a prior drag ended (pointerup/pointercancel reset it)", () => {
    const onChange = vi.fn();
    render(<SliderWithTicks min={0} max={100_000} value={0} ticks={TICKS} ariaLabel="Playback position" onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Playback position" });

    fireEvent.pointerDown(slider);
    fireEvent.pointerUp(slider);
    fireEvent.change(slider, { target: { value: "31000" } });
    expect(onChange).toHaveBeenLastCalledWith(31_000); // drag ended, no snap

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "31000" } });
    expect(onChange).toHaveBeenLastCalledWith(30_000); // dragging again, snaps

    fireEvent.pointerCancel(slider);
    fireEvent.change(slider, { target: { value: "31000" } });
    expect(onChange).toHaveBeenLastCalledWith(31_000); // cancelled, no snap
  });

  it("disables the underlying input when disabled", () => {
    render(<SliderWithTicks min={0} max={0} value={0} ticks={[]} disabled ariaLabel="Playback position" onChange={vi.fn()} />);
    expect((screen.getByRole("slider", { name: "Playback position" }) as HTMLInputElement).disabled).toBe(true);
  });
});
