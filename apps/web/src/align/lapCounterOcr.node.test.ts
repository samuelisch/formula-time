// Runs the real tesseract.js (no fake) against real-footage crops of the
// broadcast HUD lap counter, the OCR counterpart to lightsFixtures.test.ts's
// pixel traces. Needs the library's language data from its CDN on first
// run, so it's opt-in (`OCR_FIXTURES=1 pnpm vitest run
// lapCounterOcr.node.test.ts`) and skipped by default -- the commit hook
// and CI stay offline; the owner runs it locally and quotes the pass count
// in the PR body. Runs in the plain-node vitest project
// (`*.node.test.ts`), not jsdom -- see vitest.config.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createOcrWorker, loadTesseract, type OcrWorker } from "./capture.ts";
import { parseLapText } from "./core.ts";
import manifest from "./fixtures/lap-counter/manifest.json" with { type: "json" };

interface ManifestFrame {
  file: string;
  clip: string;
  t_ms: number;
  lap: number | null;
  total: number | null;
  note?: string;
}

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/lap-counter/", import.meta.url));
const FLIP_FRAME = "lap-change-0500ms.png";
const PASS_RATE_MIN = 0.9; // "at least nine of every ten frames" (issue #241)

const frames = manifest.frames as ManifestFrame[];
const readableFrames = frames.filter((frame): frame is ManifestFrame & { lap: number; total: number } => frame.lap !== null);
const blankFrames = frames.filter((frame) => frame.lap === null);

describe.skipIf(!process.env.OCR_FIXTURES)("lap counter OCR against real footage crops", () => {
  let worker: OcrWorker;

  beforeAll(async () => {
    const tesseract = await loadTesseract();
    worker = await createOcrWorker(tesseract);
  }, 60_000);

  afterAll(async () => {
    await worker.terminate();
  });

  async function readFrame(file: string): Promise<ReturnType<typeof parseLapText>> {
    const buffer = readFileSync(path.join(FIXTURES_DIR, file));
    // OcrWorker's `recognize` is typed for the browser's canvas call site;
    // the real library also accepts a Buffer (its `ImageLike` union,
    // `src/index.d.ts`), which is what this Node-side test has to offer.
    const result = await worker.recognize(buffer as unknown as HTMLCanvasElement);
    return parseLapText(result.data.text);
  }

  test(
    "reads the manifest's lap on at least 90% of frames that have a counter on screen",
    async () => {
      const results = await Promise.all(readableFrames.map((frame) => readFrame(frame.file)));
      const passes = results.filter((reading, index) => reading?.lap === readableFrames[index]!.lap && reading.total === readableFrames[index]!.total);
      const passRate = passes.length / readableFrames.length;
      expect(passRate, `${passes.length}/${readableFrames.length} frames read correctly (need >= ${PASS_RATE_MIN * 100}%)`).toBeGreaterThanOrEqual(
        PASS_RATE_MIN,
      );
    },
    60_000,
  );

  test(
    "reads the flip frame itself correctly -- the case that actually matters for a seek",
    async () => {
      const reading = await readFrame(FLIP_FRAME);
      expect(reading).toEqual({ lap: 15, total: 72 });
    },
    30_000,
  );

  test(
    "never reports a lap on a frame the manifest says has no counter on screen -- no false positives",
    async () => {
      const results = await Promise.all(blankFrames.map((frame) => readFrame(frame.file)));
      results.forEach((reading, index) => {
        expect(reading, `${blankFrames[index]!.file} should not have parsed a lap`).toBeNull();
      });
    },
    60_000,
  );
});
