// Client-side rebuild of the POC's server-side `/live/anchors`: jump targets
// the delay control resolves to a `delayMs` (lights-out, a lap number,
// restarts). Pure and unit-tested; the store folds pushes into it in onState.
import type { LivePush } from "./types.ts";

export interface LapAnchor {
  lap: number;
  source_time: string;
}

export interface Anchors {
  lights_out: string | null;
  laps: LapAnchor[];
  restarts: string[];
}

export function emptyAnchors(): Anchors {
  return { lights_out: null, laps: [], restarts: [] };
}

function earlierIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/**
 * Folds one push into the running anchors. `seen` holds the restart dates
 * already added to `restarts`; it is mutated in place because
 * `race_control.recent_messages` is a rolling window (last 100 rows) that
 * resends the same "SESSION STARTED" row across many pushes.
 */
export function deriveAnchors(previous: Anchors, push: LivePush, seen: Set<string>): Anchors {
  const lapsByNumber = new Map<number, string>(previous.laps.map((anchor) => [anchor.lap, anchor.source_time]));

  for (const driver of Object.values(push.state.drivers)) {
    const lap = driver.current_lap;
    if (lap === null) continue;
    const sourceTime = driver.source_timestamps["lap"];
    if (sourceTime === undefined) continue;
    const existing = lapsByNumber.get(lap);
    lapsByNumber.set(lap, existing === undefined ? sourceTime : earlierIso(existing, sourceTime));
  }

  const laps = [...lapsByNumber.entries()]
    .map(([lap, source_time]) => ({ lap, source_time }))
    .sort((a, b) => a.lap - b.lap);

  const lights_out = lapsByNumber.get(1) ?? null;

  const restarts = [...previous.restarts];
  for (const { payload } of push.state.race_control.recent_messages) {
    if (payload["category"] !== "SessionStatus" || payload["message"] !== "SESSION STARTED") continue;
    const date = payload["date"];
    if (typeof date !== "string" || seen.has(date)) continue;
    seen.add(date);
    restarts.push(date);
  }
  restarts.sort((a, b) => Date.parse(a) - Date.parse(b));

  return { lights_out, laps, restarts };
}
