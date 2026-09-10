import { leaderLap } from "./race_clock.js";
import type { DriverState, RaceState } from "./race_state.js";

// Owner ruling 2026-09-10: OpenF1 has no retirement flag, so run status is
// derived from staleness against the leader's lap, not any field OpenF1
// sends directly.
export type RunStatus = "running" | "dnf" | "dns";

function parseMillis(value: string | undefined): number | null {
  if (value === undefined) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : millis;
}

function findLeader(state: RaceState): DriverState | null {
  for (const candidate of Object.values(state.drivers)) {
    if (candidate.position === 1) return candidate;
  }
  return null;
}

/**
 * Pure, derived run status for one driver. Never guesses: any missing
 * timestamp or missing leader falls back to "running".
 *
 * dns: the leader has reached lap 2+ and this driver has no lap row at all.
 * dnf: this driver is 3+ laps behind the leader and its last intervals
 * update predates the leader's current lap start — a car still receiving
 * intervals rows (every few seconds) stays "running" even 3+ laps down,
 * since a lap takes about 90s.
 */
export function runStatus(state: RaceState, driverNumber: number): RunStatus {
  const driver = state.drivers[String(driverNumber)];
  if (driver === undefined) return "running";

  const currentLeaderLap = leaderLap(state);

  if (driver.current_lap === null) {
    return currentLeaderLap >= 2 ? "dns" : "running";
  }

  const lapsDown = currentLeaderLap - driver.current_lap;
  if (lapsDown < 3) return "running";

  const leader = findLeader(state);
  if (leader === null) return "running";

  const intervalsMillis = parseMillis(driver.source_timestamps["intervals"]);
  const leaderLapStartMillis = parseMillis(leader.source_timestamps["lap"]);
  if (intervalsMillis === null || leaderLapStartMillis === null) return "running";

  return intervalsMillis < leaderLapStartMillis ? "dnf" : "running";
}
