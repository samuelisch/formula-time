// Board components read the push to render through this module, never the
// live store directly (ADR-0009 amendment, issue #48 "Amendment"): the same
// components must later render a historical race the browser folded from an
// export file, not only the live feed. `BoardSourceProvider` supplies that
// push explicitly for a replay page (later issue); with no provider mounted,
// the hooks fall back to the live store's `useDisplayed()`
// (apps/web/src/live/selectors.ts). The live `BoardPage` mounts no provider.
//
// A plain .ts file (not .tsx) by the issue's file list, so `BoardSourceProvider`
// is built with `createElement` rather than JSX.
import type { DriverState, RaceState } from "@formula-time/domain";
import { leaderLap } from "@formula-time/domain";
import { createContext, createElement, useContext, useMemo, useRef, type ReactNode } from "react";

import { sessionStatusOf, useDisplayed, type SessionStatusValue } from "../live/selectors.ts";
import type { LivePush } from "../live/types.ts";

export interface BoardSource {
  push: LivePush | null;
}

const BoardSourceContext = createContext<BoardSource | null>(null);

export interface BoardSourceProviderProps {
  push: LivePush | null;
  children: ReactNode;
}

/** Mounted by a replay page (later issue) to render a folded push instead of the live feed. */
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

/** The viewer's own lap (the displayed push), never the live one -- PRD §4 review note: the live lap leaks how far the race really is. */
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

/**
 * One driver's state, memoised on push identity and stable by value: an
 * unchanged driver returns the same object reference across pushes, so a
 * memoised `DriverRow` (default shallow prop comparison) skips re-rendering
 * for every driver a push did not touch.
 */
export function useBoardDriver(driverNumber: number): DriverState | null {
  const push = useBoardPush();
  const cacheRef = useRef<{ driverNumber: number; snapshot: string; value: DriverState | null } | null>(null);

  return useMemo(() => {
    const driver = push === null ? null : (push.state.drivers[String(driverNumber)] ?? null);
    const snapshot = JSON.stringify(driver);
    const cached = cacheRef.current;
    if (cached !== null && cached.driverNumber === driverNumber && cached.snapshot === snapshot) {
      return cached.value;
    }
    cacheRef.current = { driverNumber, snapshot, value: driver };
    return driver;
  }, [push, driverNumber]);
}
