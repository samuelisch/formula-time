// Board components read the push to render through this module, never the
// live store directly (ADR-0009 amendment): the same components must render
// a historical race the browser folded from an export file, not only the
// live feed. `BoardSourceProvider` supplies that push explicitly on the
// replay page (`pages/ReplayPage.tsx`); with no provider mounted, the hooks
// fall back to the live store's `useDisplayed()`
// (apps/web/src/live/selectors.ts). The live `BoardPage` mounts no
// provider. Polls read through this seam too (`polls/usePolls.ts`): `Shell`
// holds the live connection open on every route, and a replay's push
// carries `polls: []`, so a replay never shows or opens today's live polls.
//
// A plain .ts file (not .tsx), so `BoardSourceProvider` is built with
// `createElement` rather than JSX.
import type { DriverState, RaceState } from "@formula-time/domain";
import { leaderLap } from "@formula-time/domain";
import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from "react";

import { sessionStatusOf, useDisplayed, type SessionStatusValue } from "../live/selectors.ts";
import { axisOf, type LivePush } from "../live/types.ts";

interface BoardSource {
  push: LivePush | null;
}

const BoardSourceContext = createContext<BoardSource | null>(null);

export interface BoardSourceProviderProps {
  push: LivePush | null;
  children: ReactNode;
}

/** Mounted by the replay page to render a folded push instead of the live feed. */
export function BoardSourceProvider({ push, children }: BoardSourceProviderProps) {
  const value = useMemo<BoardSource>(() => ({ push }), [push]);
  return createElement(BoardSourceContext.Provider, { value }, children);
}

/** The `LivePush`-shaped value board components render: the mounted provider's push, or the live store's displayed push when no provider is mounted. */
export function useBoardPush(): LivePush | null {
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
 * One driver's state, stable by value: an unchanged driver returns the same
 * object reference across pushes, so a memoised `DriverRow` (default
 * shallow prop comparison) skips re-rendering for every driver a push did
 * not touch. Stored in state (not a ref) and updated during render via
 * React's "adjust state during render" pattern -- setting state while
 * rendering is safe and causes React to redo this render immediately with
 * the new state, before anything is committed or painted.
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
 * Folds one push into the previous cue state, given the current wall-clock
 * time: the baseline resets silently (no cue) on a new session or whenever
 * the push's axis (`axisOf()`, the same anchor alignment uses) goes
 * backwards, which is what a replay rewind/scrub looks like -- that is the
 * one rule that keeps a delayed or scrubbing viewer from seeing a cue for a
 * "change" that is really just the playhead moving backwards. A cue is
 * pruned once `now` is more than `POSITION_CUE_TTL_MS` past the push that
 * set it.
 */
function advancePositionCueState(previous: PositionCueState, push: LivePush, now: number): PositionCueState {
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
  push: LivePush | null;
  cueState: PositionCueState;
}

/**
 * Position deltas since the previous push, keyed by driver number: positive
 * means the driver gained places, negative means it lost them, and a driver
 * absent from the result has no live cue.
 *
 * The fold (`advancePositionCueState`) runs during render via React's
 * "adjust state during render" pattern (setting state while rendering,
 * guarded so it only fires once per push, causes React to redo this render
 * immediately with the new state before anything commits or paints) rather
 * than a ref or an effect -- so the cue expiry it computes is checked each
 * time a push arrives, not on a per-row timer: a cue can outlive its TTL by
 * up to one push interval if pushes are sparse, an acceptable trade for not
 * running a timer per driver row.
 */
export function useBoardPositionDeltas(): Record<number, number> {
  const push = useBoardPush();
  const [snapshot, setSnapshot] = useState<PositionCueSnapshot>(() => ({ push: null, cueState: emptyPositionCueState() }));

  if (push !== null && push !== snapshot.push) {
    const cueState = advancePositionCueState(snapshot.cueState, push, wallClockMillis());
    setSnapshot({ push, cueState });
    return deltasOf(cueState);
  }

  return push === null ? {} : deltasOf(snapshot.cueState);
}
