// Pure math for `SliderWithTicks`, split out of the component file so it
// stays a components-only module (react-refresh's `only-export-components`
// rule) while `snapTarget`/`currentLap` stay independently unit-testable.
const SNAP_THRESHOLD_RATIO = 0.015; // ±1.5% of the range, the "resistance"

export interface TickMark {
  /** Position on the slider's own axis (ms), already clamped into `[min, max]` by the caller. */
  value: number;
  lap: number;
}

/**
 * The nearest tick within ±1.5% of `raw`, or null when none is close
 * enough. Simulates "resistance" at a lap separator: a drag that lands
 * close to a tick locks onto it rather than the raw pointer position.
 */
export function snapTarget(raw: number, ticks: readonly TickMark[], min: number, max: number): TickMark | null {
  const span = max - min;
  if (span <= 0 || ticks.length === 0) return null;
  const threshold = span * SNAP_THRESHOLD_RATIO;

  let nearest: TickMark | null = null;
  let nearestDistance = Infinity;
  for (const tick of ticks) {
    const distance = Math.abs(tick.value - raw);
    if (distance < nearestDistance) {
      nearest = tick;
      nearestDistance = distance;
    }
  }
  return nearest !== null && nearestDistance <= threshold ? nearest : null;
}

/** The label for the thumb's tooltip: the latest tick at or before `value`, or null before the first one. */
export function currentLap(value: number, ticks: readonly TickMark[]): number | null {
  let best: TickMark | null = null;
  for (const tick of ticks) {
    if (tick.value <= value && (best === null || tick.value > best.value)) {
      best = tick;
    }
  }
  return best?.lap ?? null;
}

export function percent(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return ((value - min) / (max - min)) * 100;
}
