// Where a replay's scrub bar and playback begin: the formation lap, not the
// recording's first row (which can sit well before it). OpenF1 carries no
// formation-lap event, so an on-time race starts at its scheduled
// `date_start` and a delayed race starts `FORMATION_WINDOW_MS` before its
// measured lights-out -- the only place a delayed start is visible at all.

/** Measured lights-out gap over `date_start` across three races: 3.5, 3.5 and 4.1 minutes -- five minutes covers all three with margin. */
export const FORMATION_WINDOW_MS = 5 * 60_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface ReplayStartInput {
  firstSourceMs: number | null;
  lastSourceMs: number | null;
  dateStartMs: number | null;
  lightsOutMs: number | null;
}

/**
 * The source-time position a replay's playback and scrub bar begin at.
 * Null (nothing to play) when the fold has no first event; otherwise the
 * scheduled or delayed formation-lap start, clamped to what the fold
 * actually covers.
 */
export function replayStartMs({
  firstSourceMs,
  lastSourceMs,
  dateStartMs,
  lightsOutMs,
}: ReplayStartInput): number | null {
  if (firstSourceMs === null) return null;

  const candidate =
    lightsOutMs !== null
      ? Math.max(dateStartMs ?? Number.NEGATIVE_INFINITY, lightsOutMs - FORMATION_WINDOW_MS)
      : (dateStartMs ?? firstSourceMs);

  return clamp(candidate, firstSourceMs, lightsOutMs ?? lastSourceMs ?? firstSourceMs);
}
