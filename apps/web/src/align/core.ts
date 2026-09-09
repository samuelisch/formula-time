// Pure alignment core: OCR-text parsing, lap tracking, correction policy, and
// the pixel-diff gate. No DOM, no capture — runs in the browser AND in node
// tests. Spec: docs/superpowers/specs/2026-09-05-broadcast-align-design.md
//
// Ported verbatim from the POC (`poc/ui/align_core.js` /
// `poc/ui/align_core.d.ts`) into strict TypeScript. Behaviour is unchanged;
// only types were added.

export interface LapReading {
  lap: number;
  total: number;
}

// "LAP 34/72"-shaped OCR text (possibly noisy) -> { lap, total } | null.
export function parseLapText(text: unknown): LapReading | null {
  if (typeof text !== "string") return null;
  const match = text.replace(/\s+/g, " ").match(/(\d{1,2})\s*\/\s*(\d{1,3})/);
  if (!match) return null;
  const lap = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(lap) || !Number.isInteger(total)) return null;
  // Sanity bounds: no F1 race is under 2 or over 120 laps; lap can't exceed total.
  if (lap < 1 || total < 2 || total > 120 || lap > total) return null;
  return { lap, total };
}

export interface LapTracker {
  accept(lap: number): "first" | "same" | "flip" | "rejected";
  current(): number | null;
}

// Monotonic guard: only lastLap+1 is a time-anchored flip. A "first" read
// tells us the lap but not when it started.
//
// A counter hidden across >=2 flips (cutaway/replay) or a bad first read
// would otherwise wedge the tracker forever — every later read rejected,
// silently. After 3 CONSECUTIVE reads of the same rejected value, re-lock to
// it as an unanchored "first" (never as a "flip": a re-lock never claims to
// know when that lap started, same as any other first read). The
// consecutive count resets on any non-rejected verdict or on a different
// rejected value, so noisy misreads that don't agree with each other never
// trigger a re-lock.
export function createLapTracker(): LapTracker {
  let lastLap: number | null = null;
  let rejectedValue: number | null = null;
  let rejectedCount = 0;
  return {
    accept(lap: number) {
      if (lastLap === null) {
        lastLap = lap;
        return "first";
      }
      if (lap === lastLap) {
        rejectedValue = null;
        rejectedCount = 0;
        return "same";
      }
      if (lap === lastLap + 1) {
        lastLap = lap;
        rejectedValue = null;
        rejectedCount = 0;
        return "flip";
      }
      if (lap === rejectedValue) {
        rejectedCount += 1;
      } else {
        rejectedValue = lap;
        rejectedCount = 1;
      }
      if (rejectedCount >= 3) {
        lastLap = lap;
        rejectedValue = null;
        rejectedCount = 0;
        return "first"; // re-lock: unanchored, same as any other first read
      }
      return "rejected"; // misread, replay graphic, or camera cut — hold position
    },
    current() {
      return lastLap;
    },
  };
}

// Correction policy: inside the deadband do nothing; beyond it, seek to the
// anchor. Rate-warp smoothing is not implemented here.
export function decideCorrection(deltaMs: number, deadbandMs = 300): "none" | "seek" {
  if (!Number.isFinite(deltaMs)) return "none";
  return Math.abs(deltaMs) <= deadbandMs ? "none" : "seek";
}

export interface AnchorLap {
  lap: number;
  source_time: string;
}
export interface Anchors {
  lights_out?: string | null;
  laps?: AnchorLap[];
}

// Which anchor source_time to align to for a given lap read. Lap 1 prefers
// lights_out ONLY on a genuine first-ever lock — a re-lock at lap 1 is
// evidence of a misread storm, not race start, so it's treated like any
// other lap lookup. Null when the data side hasn't produced that anchor yet
// (caller retries at the next lap).
export function chooseAnchorTarget(
  anchors: Anchors | null | undefined,
  lap: number,
  isRelock: boolean,
): string | null {
  if (!anchors) return null;
  if (lap === 1 && !isRelock) {
    return anchors.lights_out ?? anchors.laps?.find((candidate) => candidate.lap === 1)?.source_time ?? null;
  }
  return anchors.laps?.find((candidate) => candidate.lap === lap)?.source_time ?? null;
}

// Compensate an anchor target for the handling time elapsed since the frame
// that produced the read was grabbed: OCR plus the anchor fetch can take
// hundreds of ms to several seconds, and without this the correction chases
// a target that's already stale, re-baselining the view behind the
// broadcast. Null-safe: garbage in, null out.
export function compensateTarget(targetIso: string | null | undefined, elapsedMs: number): string | null {
  if (typeof targetIso !== "string") return null;
  const parsed = Date.parse(targetIso);
  if (!Number.isFinite(parsed) || !Number.isFinite(elapsedMs)) return null;
  return new Date(parsed + elapsedMs).toISOString();
}

// Cheap diff gate so OCR only runs when the crop region actually changed.
// Metric: FRACTION of pixels whose R channel moved by more than PIXEL_DELTA.
// (A mean-abs-diff metric proved blind to a single digit flipping inside a
// generous crop — caught by the closed-loop harness, 2026-09-05: "LAP 1"→
// "LAP 2" changes ~1% of pixels, mean diff ~2, and OCR gated off forever.)
const PIXEL_DELTA = 25; // per-pixel intensity change that counts as "changed"

export function regionChanged(
  previous: ArrayLike<number> | null,
  next: ArrayLike<number>,
  changedFraction = 0.004,
): boolean {
  if (!previous || previous.length !== next.length) return true;
  const samples = next.length / 4;
  if (samples === 0) return false;
  let changed = 0;
  for (let i = 0; i < next.length; i += 4) {
    if (Math.abs(next[i]! - previous[i]!) > PIXEL_DELTA) changed += 1;
  }
  return changed / samples > changedFraction;
}

// --- Whole-frame lights-out detection (precision spec B) ---
// The gantry has a temporal signature, not a known position: saturated-red
// cells that hold ≥2s then extinguish within one frame, inside a continuous
// shot. A camera cut changes most cells at once and is vetoed.

export function redFractionGrid(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  cols = 12,
  rows = 7,
): number[] {
  const cells = cols * rows;
  const red = new Array<number>(cells).fill(0);
  const counts = new Array<number>(cells).fill(0);
  for (let y = 0; y < height; y += 1) {
    const row = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x += 1) {
      const col = Math.min(cols - 1, Math.floor((x * cols) / width));
      const cell = row * cols + col;
      const i = (y * width + x) * 4;
      counts[cell]! += 1;
      const r = pixels[i]!;
      const g = pixels[i + 1]!;
      const b = pixels[i + 2]!;
      // Union of two red worlds, both measured on real broadcast clips
      // (2026-09-06): deep LED red (r>150, r>2g, r>2b) AND warm blooming red
      // (r=~226 g=~154 b=~124 on the owner's second start clip — the old
      // saturated-only test was mathematically blind to it).
      if ((r > 150 && r > 2 * g && r > 2 * b) || (r > 170 && r - g > 60 && r - b > 90)) red[cell]! += 1;
    }
  }
  return red.map((count, cell) => (counts[cell] === 0 ? 0 : count / counts[cell]!));
}

// Per-sample scalar summary of a grid: how many tiles are "lit" red and what
// fraction of tiles moved since the previous grid. This is ALL the detector
// consumes — split out so real footage can be reduced to compact traces and
// replayed in node tests.
export function countLit(grid: number[], litThreshold = 0.25): number {
  let count = 0;
  for (let i = 0; i < grid.length; i += 1) if (grid[i]! >= litThreshold) count += 1;
  return count;
}

export function changedFraction(grid: number[], previous: number[] | null): number {
  if (!previous || previous.length !== grid.length) return 0;
  let changed = 0;
  for (let i = 0; i < grid.length; i += 1) {
    if (Math.abs(grid[i]! - previous[i]!) > 0.05) changed += 1;
  }
  return changed / grid.length;
}

export interface LightsSummary {
  count: number;
  changed: number;
}
export interface LightsOutDetector {
  push(grid: number[], wall: number): { wall: number; cells: number[] } | null;
  pushSummary(summary: LightsSummary, wall: number): { wall: number; cells: number[] } | null;
}

export function createLightsOutDetector(options: {
  litThreshold?: number;
  riseMin?: number;
  rampMs?: number;
  dropKeep?: number;
  windowMs?: number;
  cutFraction?: number;
} = {}): LightsOutDetector {
  // Validated against real broadcast footage (2026-09-06 owner clip, Zandvoort
  // start): the five gantry lights are TINY next to trackside red signage, so
  // per-tile stability tracking drowns in noise. What survives reality is the
  // scalar signature: the count of red tiles (fine grid) RAMPS as lights come
  // on one by one (>= riseMin above the trailing-window floor, sustained
  // >= rampMs), then COLLAPSES toward the floor in a single step, inside a
  // continuous shot. Signage is static (no ramp); camera cuts are instant
  // (no ramp) and vetoed by the global-change check. On the owner clip this
  // fires exactly once, at the true lights-out frame.
  const litThreshold = options.litThreshold ?? 0.25;
  const riseMin = options.riseMin ?? 4;
  const rampMs = options.rampMs ?? 2000;
  const dropKeep = options.dropKeep ?? 0.3;
  const windowMs = options.windowMs ?? 12000;
  const cutFraction = options.cutFraction ?? 0.35;
  const history: { wall: number; count: number }[] = [];
  let previous: number[] | null = null;
  function pushSummary(summary: LightsSummary, wall: number): { wall: number; cells: number[] } | null {
    const count = summary.count;
    const cut = summary.changed > cutFraction;
    while (history.length > 0 && history[0]!.wall < wall - windowMs) history.shift();
    // Baseline and ramp come from the PAST only — including the current
    // (possibly collapsed) frame would let any flat-then-drop pattern
    // manufacture a retroactive "ramp".
    let base = Infinity;
    for (const entry of history) if (entry.count < base) base = entry.count;
    const rampStart = wall - rampMs;
    let sawRamp = false;
    let rampOk = true;
    let peak = 0;
    for (const entry of history) {
      if (entry.wall >= rampStart) {
        sawRamp = true;
        if (entry.count < base + riseMin) rampOk = false;
        if (entry.count > peak) peak = entry.count;
      }
    }
    const fires = sawRamp && rampOk && !cut && Number.isFinite(base) && count <= base + (peak - base) * dropKeep;
    history.push({ wall, count });
    return fires ? { wall, cells: [] } : null;
  }
  return {
    push(grid: number[], wall: number) {
      const summary: LightsSummary = { count: countLit(grid, litThreshold), changed: changedFraction(grid, previous) };
      previous = grid;
      return pushSummary(summary, wall);
    },
    pushSummary,
  };
}

// --- Predictive alignment (spec 2026-09-05-predictive-alignment) ---
// The OFFSET (screen wall-clock minus anchor source time) is the aligned
// session's real state; individual events are noisy evidence. Lights-out
// (pixel path, ±0.1s) seeds/overwrites; OCR flips (±0.5-0.8s jitter) nudge
// via a small EMA gain, so averaging shrinks their noise. A sample far off
// the estimate is a misread — discarded; three consecutive agreeing
// discards mean the world changed (big stream re-buffer, wrong lock): adopt.

export interface OffsetTracker {
  observe(
    anchorIso: string | null | undefined,
    observedWall: number,
    kind: "lights" | "flip",
  ): "seeded" | "accepted" | "discarded" | "relock";
  offsetMs(): number | null;
  observationCount(): number;
}

export function createOffsetTracker(options: {
  discardBeyondMs?: number;
  relockAfter?: number;
  flipGain?: number;
} = {}): OffsetTracker {
  const discardBeyondMs = options.discardBeyondMs ?? 3000;
  const relockAfter = options.relockAfter ?? 3;
  const flipGain = options.flipGain ?? 0.3;
  let offset: number | null = null;
  let discards = 0;
  let count = 0;
  return {
    observe(anchorIso, observedWall, kind) {
      const anchor = Date.parse(anchorIso ?? "");
      if (!Number.isFinite(anchor) || !Number.isFinite(observedWall)) return "discarded";
      const sample = observedWall - anchor;
      if (offset === null || kind === "lights") {
        offset = sample;
        discards = 0;
        count += 1;
        return "seeded";
      }
      if (Math.abs(sample - offset) > discardBeyondMs) {
        discards += 1;
        if (discards >= relockAfter) {
          offset = sample;
          discards = 0;
          count += 1;
          return "relock";
        }
        return "discarded";
      }
      discards = 0;
      offset += flipGain * (sample - offset);
      count += 1;
      return "accepted";
    },
    offsetMs() {
      return offset;
    },
    observationCount() {
      return count;
    },
  };
}

// When will this anchor's event appear on THIS viewer's screen?
export function predictFlipWall(anchorIso: string | null | undefined, offsetMs: number): number | null {
  const anchor = Date.parse(anchorIso ?? "");
  if (!Number.isFinite(anchor) || !Number.isFinite(offsetMs)) return null;
  return anchor + offsetMs;
}

// --- Auto-locating the HUD counter (no user-drawn box needed) ---
// Tesseract reports WHERE each recognized line sits. Scan a full-frame OCR
// result for the first line whose text parses as LAP N/M; its bbox becomes
// the crop, padded so digit-width changes (9 -> 10, 99 -> 100) stay inside.

export interface OcrLine {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export function findLapLine(lines: ReadonlyArray<OcrLine> | null | undefined): OcrLine | null {
  if (!Array.isArray(lines)) return null;
  for (const line of lines) {
    if (!line || typeof line.text !== "string" || !line.bbox) continue;
    if (parseLapText(line.text) !== null) return { text: line.text, bbox: line.bbox };
  }
  return null;
}

export function cropFromBBox(
  bbox: { x0: number; y0: number; x1: number; y1: number } | null | undefined,
  frameWidth: number,
  frameHeight: number,
  padX = 0.35,
  padY = 0.6,
): { x: number; y: number; w: number; h: number } | null {
  if (!bbox || !(frameWidth > 0) || !(frameHeight > 0)) return null;
  const { x0, y0, x1, y1 } = bbox;
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  const left = Math.max(0, x0 - w * padX);
  const top = Math.max(0, y0 - h * padY);
  const right = Math.min(frameWidth, x1 + w * padX);
  const bottom = Math.min(frameHeight, y1 + h * padY);
  return {
    x: left / frameWidth,
    y: top / frameHeight,
    w: (right - left) / frameWidth,
    h: (bottom - top) / frameHeight,
  };
}
