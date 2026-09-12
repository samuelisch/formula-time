import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyAnchors } from "../live/anchors.ts";
import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import { TimeTargetProvider } from "../transport/TimeTarget.ts";
import { useLiveTimeTarget } from "../transport/useLiveTimeTarget.ts";
import { AlignPanel } from "./AlignPanel.tsx";
import type { AlignerState, Diagnostics } from "./useAligner.ts";

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

// The diagnostics-rendering tests below don't need a real capture/OCR
// lifecycle -- they're only checking how AlignPanel renders a given
// AlignerState -- so useAligner itself is mocked, defaulting to the real
// implementation (every other test in this file still exercises it for
// real) and overridden per test with `useAligner.mockReturnValue(...)`.
vi.mock("./useAligner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useAligner.ts")>();
  return { ...actual, useAligner: vi.fn(actual.useAligner) };
});

const { useAligner } = await import("./useAligner.ts");
// The real implementation, bypassing the mock above -- restored in
// beforeEach so every test except the diagnostics-rendering ones below
// keeps exercising the real hook.
const { useAligner: realUseAligner } = await vi.importActual<typeof import("./useAligner.ts")>("./useAligner.ts");

const EMPTY_DIAGNOSTICS: Diagnostics = { lastText: null, lastError: null, lastSampleAt: null, attempts: 0, accepted: 0, history: [] };

function fakeAlignerState(overrides: Partial<AlignerState> = {}): AlignerState {
  return {
    phase: "running",
    status: "Watching",
    diagnostics: EMPTY_DIAGNOSTICS,
    crop: null,
    visible: true,
    previewCanvasRef: () => {},
    onPreviewPointerDown: () => {},
    onPreviewPointerUp: () => {},
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  };
}

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
    vi.mocked(useAligner).mockImplementation(realUseAligner);
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

  describe("diagnostics line and verdict history", () => {
    it("renders the exact 'OCR: text · Ns ago · reads a/b' format", () => {
      vi.mocked(useAligner).mockReturnValue(
        fakeAlignerState({
          diagnostics: { lastText: "LAP 15/72", lastError: null, lastSampleAt: Date.now() - 5_000, attempts: 8, accepted: 6, history: [] },
        }),
      );

      render(<LiveAlignPanel />);

      expect(screen.getByText('OCR: "LAP 15/72" · 5s ago · reads 6/8')).toBeInTheDocument();
    });

    it("shows the rejection's error message in place of raw text", () => {
      vi.mocked(useAligner).mockReturnValue(
        fakeAlignerState({
          diagnostics: { lastText: null, lastError: "worker crashed", lastSampleAt: Date.now() - 2_000, attempts: 3, accepted: 1, history: [] },
        }),
      );

      render(<LiveAlignPanel />);

      expect(screen.getByText('OCR: "worker crashed" · 2s ago · reads 1/3')).toBeInTheDocument();
    });

    it("shows a placeholder before any sample has landed", () => {
      vi.mocked(useAligner).mockReturnValue(fakeAlignerState({ diagnostics: EMPTY_DIAGNOSTICS }));

      render(<LiveAlignPanel />);

      expect(screen.getByText("OCR: no samples yet")).toBeInTheDocument();
    });

    it("renders the verdict history as a list, oldest first, capped at three entries", () => {
      vi.mocked(useAligner).mockReturnValue(
        fakeAlignerState({
          diagnostics: { ...EMPTY_DIAGNOSTICS, history: ["locked", "rejected: expected 4", "flip accepted"] },
        }),
      );

      render(<LiveAlignPanel />);

      const items = screen.getAllByRole("listitem");
      expect(items.map((item) => item.textContent)).toEqual(["locked", "rejected: expected 4", "flip accepted"]);
    });

    it("renders no history list when nothing has verdicted yet", () => {
      vi.mocked(useAligner).mockReturnValue(fakeAlignerState({ diagnostics: EMPTY_DIAGNOSTICS }));

      render(<LiveAlignPanel />);

      expect(screen.queryByRole("list")).not.toBeInTheDocument();
    });
  });
});
