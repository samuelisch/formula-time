import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyAnchors } from "../live/anchors.ts";
import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import { TimeTargetProvider } from "../transport/TimeTarget.ts";
import { useLiveTimeTarget } from "../transport/useLiveTimeTarget.ts";
import { AlignPanel } from "./AlignPanel.tsx";

// `useAligner` (inside `AlignPanel`) reads through `useTimeTarget()` (issue
// #67), so every render here needs a provider -- the live-backed one
// `BoardPage` mounts in the app.
function LiveAlignPanel() {
  const target = useLiveTimeTarget();
  return (
    <TimeTargetProvider value={target}>
      <AlignPanel />
    </TimeTargetProvider>
  );
}

// The hook's default capture entry points (capture.ts) reach real browser
// APIs jsdom doesn't implement (getDisplayMedia) or a real npm package
// (tesseract.js) this suite has no reason to exercise -- stub just those
// three, keep everything else (crop storage, canvas draw) real: it no-ops
// harmlessly against jsdom's canvas.
vi.mock("./capture.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capture.ts")>();
  return {
    ...actual,
    loadTesseract: vi.fn(),
    captureDisplayMedia: vi.fn(),
    createOcrWorker: vi.fn(),
  };
});

const { captureDisplayMedia, createOcrWorker, loadTesseract } = await import("./capture.ts");

function resetStore(): void {
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
  });
}

describe("AlignPanel", () => {
  beforeEach(() => {
    resetStore();
    vi.mocked(loadTesseract).mockReset();
    vi.mocked(captureDisplayMedia).mockReset();
    vi.mocked(createOcrWorker).mockReset();
    try {
      localStorage.clear();
    } catch {
      /* not available in this environment */
    }
  });

  it("shows only the start button before capture begins", () => {
    render(<LiveAlignPanel />);
    expect(screen.getByRole("button", { name: /Align with my screen/ })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the panel and a busy status once capture starts", async () => {
    const user = userEvent.setup();
    // Never resolves within this test -- captures the "starting" busy state
    // before anything about capture succeeds or fails.
    vi.mocked(loadTesseract).mockReturnValue(new Promise(() => {}));

    render(<LiveAlignPanel />);
    await user.click(screen.getByRole("button", { name: /Align with my screen/ }));

    expect(screen.getByRole("status")).toHaveTextContent("Loading OCR…");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("shows the 'Couldn't start' status when screen capture fails", async () => {
    const user = userEvent.setup();
    vi.mocked(loadTesseract).mockResolvedValue({ createWorker: vi.fn() });
    vi.mocked(captureDisplayMedia).mockRejectedValue(new Error("Permission denied"));

    render(<LiveAlignPanel />);
    await user.click(screen.getByRole("button", { name: /Align with my screen/ }));

    expect(
      await screen.findByText(
        "Couldn't start: Permission denied — check network (OCR loads from a CDN) and allow screen sharing, then try again",
      ),
    ).toBeInTheDocument();
    // Phase reset to idle (capture never got going) -- the panel offers a
    // retry rather than Stop, but stays up so the failure is seen.
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });
});
