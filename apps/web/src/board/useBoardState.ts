// Board components read the push to render through this module, never the
// live store directly (ADR-0009 amendment): the same components render a
// historical race the browser folded from an export file, not only the
// live feed. `BoardSourceProvider` supplies that push on the replay page;
// with no provider, the hooks fall back to `useDisplayed()`.
// See README: The two seams.
import type { DriverState, RaceState, RunStatus } from "@formula-time/domain";
import { leaderLap, runStatus } from "@formula-time/domain";
import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from "react";

import { sessionStatusOf, useDisplayed, type SessionStatusValue } from "../live/selectors.ts";
import { axisOf, type StatePush } from "../live/types.ts";

interface BoardSource {
  push: StatePush | null;
}

const BoardSourceContext = createContext<BoardSource | null>(null);

export interface BoardSourceProviderProps {
  push: StatePush | null;
  children: ReactNode;
}

/** Mounted by the replay page to render a folded push instead of the live feed. */
export function BoardSourceProvider({ push, children }: BoardSourceProviderProps) {
  const value = useMemo<BoardSource>(() => ({ push }), [push]);
  return createElement(BoardSourceContext.Provider, { value }, children);
}

/** The `StatePush`-shaped value board components render: the mounted provider's push, or the live store's displayed push when no provider is mounted. */
export function useBoardPush(): StatePush | null {
  const provided = useContext(BoardSourceContext);
  const live = useDisplayed();
  return provided !== null ? provided.push : live;
}

/** True when a `BoardSourceProvider` is mounted -- only `ReplayPage` does that -- so board components can default differently on replay (e.g. the race-control feed starts expanded there, collapsed on live). */
export function useBoardIsReplay(): boolean {
  return useContext(BoardSourceContext) !== null;
}

const EMPTY_RACE_CONTROL: RaceState["race_control"] = {
  session_status: null,
  current_flag: null,
  safety_car: null,
  active_flags: {},
  driver_flags: {},
  recent_messages: [],
};

export function useBoardRaceControl(): RaceState["race_control"] {
  const push = useBoardPush();
  return push === null ? EMPTY_RACE_CONTROL : push.state.race_control;
}

export function useBoardWeather(): RaceState["weather"] {
  const push = useBoardPush();
  return push === null ? null : push.state.weather;
}

/** The number of drivers in the displayed push, or 0 before any push has arrived. */
export function useBoardDriverCount(): number {
  const push = useBoardPush();
  return push === null ? 0 : Object.keys(push.state.drivers).length;
}

/** The viewer's own lap (the displayed push), never the live one -- PRD §4: the live lap leaks how far the race really is. */
export function useBoardLeaderLap(): number {
  const push = useBoardPush();
  return push === null ? 0 : leaderLap(push.state);
}

export interface BoardSessionMeta {
  sessionKey: string | null;
  totalLaps: number | null;
  session: RaceState["session"];
}

export function useBoardSessionMeta(): BoardSessionMeta {
  const push = useBoardPush();
  return useMemo<BoardSessionMeta>(
    () => ({
      sessionKey: push?.session_key ?? null,
      totalLaps: push?.total_laps ?? null,
      session: push?.state.session ?? null,
    }),
    [push],
  );
}

/** The displayed push's session status, derived through `useBoardPush()` (not the live store directly) so this also works for a folded historical push. */
export function useBoardSessionStatus(): SessionStatusValue | null {
  const push = useBoardPush();
  return sessionStatusOf(push?.state.session ?? null);
}

/**
 * Whether a push should render as racing. The fold is the authority on
 * whether racing has begun, not the session row.
 * See README: Board layout.
 */
export function isRacingPush(push: StatePush | null): boolean {
  if (push === null) return false;
  const status = sessionStatusOf(push.state.session);
  if (status === "live") return true;
  if (status === "finished") return false;
  return push.state.race_control.session_status === "SESSION STARTED" || leaderLap(push.state) >= 1;
}

/** `isRacingPush` applied to the board seam's own push (`useBoardPush()`). */
export function useBoardIsRacing(): boolean {
  return isRacingPush(useBoardPush());
}

/** Render order for the timing table: `driver_order` (positioned, already sorted), then unpositioned drivers by number -- the POC's `renderDrivers`. */
export function useBoardDriverOrder(): number[] {
  const push = useBoardPush();
  return useMemo(() => {
    if (push === null) return [];
    const positioned = push.state.driver_order;
    const positionedSet = new Set(positioned);
    const unpositioned = Object.values(push.state.drivers)
      .filter((driver) => driver.position === null && !positionedSet.has(driver.driver_number))
      .map((driver) => driver.driver_number)
      .sort((left, right) => left - right);
    return [...positioned, ...unpositioned];
  }, [push]);
}

interface DriverCache {
  driverNumber: number;
  snapshot: string;
  value: DriverState | null;
}

/**
 * One driver's state, stable by value: an unchanged driver returns the
 * same object reference, so a memoised `DriverRow` skips re-rendering
 * drivers a push didn't touch.
 * See README: Board layout.
 */
export function useBoardDriver(driverNumber: number): DriverState | null {
  const push = useBoardPush();
  const driver = push === null ? null : (push.state.drivers[String(driverNumber)] ?? null);
  const snapshot = JSON.stringify(driver);

  const [cache, setCache] = useState<DriverCache>(() => ({ driverNumber, snapshot, value: driver }));
  if (cache.driverNumber !== driverNumber || cache.snapshot !== snapshot) {
    setCache({ driverNumber, snapshot, value: driver });
    return driver;
  }
  return cache.value;
}

/** A driver's run status (`RunStatus` from `@formula-time/domain`), computed from the displayed push -- so a delayed viewer only sees a retirement once their own lap reaches it. "running" before any push has arrived or for a driver absent from the push. */
export function useBoardRunStatus(driverNumber: number): RunStatus {
  const push = useBoardPush();
  return push === null ? "running" : runStatus(push.state, driverNumber);
}

/** How long a position-change cue stays visible after the push that set it. */
const POSITION_CUE_TTL_MS = 8000;

interface PositionCue {
  /** previous position - current position: positive is a gain, negative a loss. */
  delta: number;
  setAt: number;
}

interface PositionCueState {
  sessionKey: string | null;
  axisMillis: number | null;
  /** Each driver's position as of the last push this hook has folded in. */
  positions: Record<number, number>;
  cues: Record<number, PositionCue>;
}

function emptyPositionCueState(): PositionCueState {
  return { sessionKey: null, axisMillis: null, positions: {}, cues: {} };
}

/** The one place `useBoardPositionDeltas` reads the wall clock: isolated so its "adjust state during render" step (below) has a single, named source of the real time it needs for cue timestamps and TTL checks. */
function wallClockMillis(): number {
  return Date.now();
}

/**
 * Folds one push into the previous cue state: the baseline resets
 * silently on a new session or when the push's axis goes backwards (a
 * replay rewind/scrub), so scrubbing never shows a stale cue.
 * See README: Board layout.
 */
function advancePositionCueState(previous: PositionCueState, push: StatePush, now: number): PositionCueState {
  const axisMillis = axisOf(push);
  const isNewSession = previous.sessionKey !== push.session_key;
  const isBackwards = !isNewSession && previous.axisMillis !== null && axisMillis < previous.axisMillis;

  if (isNewSession || isBackwards) {
    const positions: Record<number, number> = {};
    for (const driver of Object.values(push.state.drivers)) {
      if (driver.position !== null) positions[driver.driver_number] = driver.position;
    }
    return { sessionKey: push.session_key, axisMillis, positions, cues: {} };
  }

  const positions = { ...previous.positions };
  const cues = { ...previous.cues };
  for (const driver of Object.values(push.state.drivers)) {
    const previousPosition = positions[driver.driver_number] ?? null;
    const current = driver.position;
    if (current !== null && previousPosition !== null && previousPosition !== current) {
      cues[driver.driver_number] = { delta: previousPosition - current, setAt: now };
    }
    if (current !== null) positions[driver.driver_number] = current;
  }
  for (const [driverNumber, cue] of Object.entries(cues)) {
    if (now - cue.setAt > POSITION_CUE_TTL_MS) delete cues[Number(driverNumber)];
  }

  return { sessionKey: push.session_key, axisMillis, positions, cues };
}

function deltasOf(cueState: PositionCueState): Record<number, number> {
  const deltas: Record<number, number> = {};
  for (const [driverNumber, cue] of Object.entries(cueState.cues)) {
    deltas[Number(driverNumber)] = cue.delta;
  }
  return deltas;
}

interface PositionCueSnapshot {
  /** The push this snapshot's `cueState` was folded from, so a later render can tell whether a new push has arrived. */
  push: StatePush | null;
  cueState: PositionCueState;
}

/**
 * Position deltas since the previous push, keyed by driver number:
 * positive is a gain, negative a loss; a driver absent from the result has
 * no live cue. The fold runs during render, not a ref or an effect.
 * See README: Board layout.
 */
export function useBoardPositionDeltas(): Record<number, number> {
  const push = useBoardPush();
  const [snapshot, setSnapshot] = useState<PositionCueSnapshot>(() => ({
    push: null,
    cueState: emptyPositionCueState(),
  }));

  if (push !== null && push !== snapshot.push) {
    const cueState = advancePositionCueState(snapshot.cueState, push, wallClockMillis());
    setSnapshot({ push, cueState });
    return deltasOf(cueState);
  }

  return push === null ? {} : deltasOf(snapshot.cueState);
}
