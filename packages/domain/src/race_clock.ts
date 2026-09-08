import type { RaceState } from "./race_state.js";

// The leader's lap is the race clock for poll lock. Fall back to the furthest
// lap any driver has reached while driver_order is still empty.
// Lifted unchanged from the POC (poc/ts/poll_engine.ts).
export function leaderLap(state: RaceState): number {
  const leaderNumber = state.driver_order[0];
  const leader = leaderNumber === undefined ? undefined : state.drivers[String(leaderNumber)];
  if (leader && leader.current_lap !== null) return leader.current_lap;
  let furthest = 0;
  for (const driver of Object.values(state.drivers)) {
    if (driver.current_lap !== null && driver.current_lap > furthest) furthest = driver.current_lap;
  }
  return furthest;
}

// The live feed's race-end signal (verified on the 2026 Dutch GP raw recording).
// The reducer folds it into active_flags / current_flag.
// Lifted unchanged from the POC (poc/ts/poll_engine.ts).
export function isChequered(state: RaceState): boolean {
  if (state.race_control.current_flag === "CHEQUERED") return true;
  return Object.values(state.race_control.active_flags).includes("CHEQUERED");
}

export type PollKind = "race-result" | "lap-event";

/** PRD §4 lock rule. race-result: halfway, floor(totalLaps / 2), minimum 1. lap-event: eventLap - 2, minimum 1. */
export function locksAtLap(kind: PollKind, args: { totalLaps: number; eventLap?: number }): number {
  if (kind === "race-result") {
    return Math.max(1, Math.floor(args.totalLaps / 2));
  }
  const eventLap = args.eventLap ?? 0;
  return Math.max(1, eventLap - 2);
}
