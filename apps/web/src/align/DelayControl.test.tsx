import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { emptyAnchors, type Anchors } from "../live/anchors.ts";
import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import { DelayControl } from "./DelayControl.tsx";

function resetStore(overrides: Partial<ReturnType<typeof useLiveStore.getState>> = {}): void {
  useLiveStore.setState({
    connection: "connecting",
    catchingUp: false,
    lastMessageAt: null,
    live: null,
    buffer: emptyBuffer(),
    delayMs: 0,
    displayed: null,
    bufferShort: false,
    anchors: emptyAnchors(),
    ...overrides,
  });
}

const bufferedSpan = { entries: [{ at: 0, raw: "{}" }, { at: 180_000, raw: "{}" }] };

// Deliberately far in the past so `Date.now() - Date.parse(source_time)`
// exceeds the buffered span regardless of when the test happens to run.
const anchorsWithLap5: Anchors = {
  lights_out: "2000-01-01T00:00:00.000Z",
  laps: [{ lap: 5, source_time: "2000-01-01T00:00:00.000Z" }],
  restarts: [],
};

describe("DelayControl", () => {
  beforeEach(() => {
    resetStore();
  });

  it("shows the current offset with one decimal", () => {
    resetStore({ delayMs: 2_500, buffer: bufferedSpan });
    render(<DelayControl />);
    expect(screen.getByText("2.5s")).toBeInTheDocument();
  });

  it("nudges delayMs by 1s and 10s through the store", async () => {
    const user = userEvent.setup();
    resetStore({ buffer: bufferedSpan });
    render(<DelayControl />);

    await user.click(screen.getByRole("button", { name: "+1s" }));
    expect(useLiveStore.getState().delayMs).toBe(1_000);

    await user.click(screen.getByRole("button", { name: "+10s" }));
    expect(useLiveStore.getState().delayMs).toBe(11_000);

    await user.click(screen.getByRole("button", { name: "−1s" }));
    expect(useLiveStore.getState().delayMs).toBe(10_000);

    await user.click(screen.getByRole("button", { name: "−10s" }));
    expect(useLiveStore.getState().delayMs).toBe(0);
  });

  it("Live resets delayMs to zero", async () => {
    const user = userEvent.setup();
    resetStore({ delayMs: 8_000, buffer: bufferedSpan });
    render(<DelayControl />);

    await user.click(screen.getByRole("button", { name: "Live" }));
    expect(useLiveStore.getState().delayMs).toBe(0);
  });

  it("sets the slider's max to the buffered span and disables it when the span is zero", () => {
    resetStore({ buffer: bufferedSpan });
    const { rerender } = render(<DelayControl />);
    const slider = screen.getByRole("slider", { name: "Delay" }) as HTMLInputElement;
    expect(slider.max).toBe("180000");
    expect(slider.disabled).toBe(false);

    resetStore();
    rerender(<DelayControl />);
    expect((screen.getByRole("slider", { name: "Delay" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("shows the bufferShort message when the delay outruns what this tab has buffered", () => {
    resetStore({ buffer: bufferedSpan, bufferShort: true });
    render(<DelayControl />);
    expect(screen.getByText("Delay exceeds what this tab has buffered; showing the oldest")).toBeInTheDocument();
  });

  it("shows a message when jumping to a lap not seen since this tab joined", async () => {
    const user = userEvent.setup();
    resetStore({ buffer: bufferedSpan });
    render(<DelayControl />);

    await user.type(screen.getByRole("spinbutton", { name: "Lap number" }), "5");
    await user.click(screen.getByRole("button", { name: "Go" }));

    expect(screen.getByText("Lap 5 not seen since you joined")).toBeInTheDocument();
    expect(useLiveStore.getState().delayMs).toBe(0);
  });

  it("jumps to a known lap's anchor, clamped to the buffered span", async () => {
    const user = userEvent.setup();
    resetStore({ buffer: bufferedSpan, anchors: anchorsWithLap5 });
    render(<DelayControl />);

    await user.type(screen.getByRole("spinbutton", { name: "Lap number" }), "5");
    await user.click(screen.getByRole("button", { name: "Go" }));

    expect(useLiveStore.getState().delayMs).toBe(180_000); // clamped: source time is far in the past
    expect(screen.queryByText(/not seen since you joined/)).not.toBeInTheDocument();
  });

  it("shows a message when jumping to lights out before it has been seen", async () => {
    const user = userEvent.setup();
    resetStore({ buffer: bufferedSpan });
    render(<DelayControl />);

    await user.click(screen.getByRole("button", { name: "Lights out" }));
    expect(screen.getByText("Lights out not seen since you joined")).toBeInTheDocument();
  });

  it("nudges delayMs with the [ and ] keys", async () => {
    const user = userEvent.setup();
    resetStore({ buffer: bufferedSpan });
    render(<DelayControl />);

    await user.keyboard("{]}");
    expect(useLiveStore.getState().delayMs).toBe(1_000);

    await user.keyboard("{[}");
    expect(useLiveStore.getState().delayMs).toBe(0);
  });
});
