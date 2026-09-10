// Which race PollsPage should show, and whether it's the current session or
// a historical one. Selection lives in the URL (`?race=<session_key>`).
//
// An explicit `?race=<key>` always wins, immediately -- the caller fetches
// its polls regardless of whether the current session is known yet, and it
// self-heals to "current" once a push confirms a matching session key.
//
// With no param, the default is "the current session, else the newest
// race" -- but "no current session is known yet" is ambiguous on its own:
// it means both "the session hasn't pushed its first state" (transient,
// resolves in moments) and "there genuinely is no session"
// (session-lifecycle.ts's `pickSession() === null`, e.g. off-season).
// Inferring the difference from `sessionKey === null` alone races
// `GET /api/races` against the first SSE push and can show a wrong,
// unrelated race's polls. Instead this hook waits for a settled signal from
// the live connection:
//   1. `connection !== "open"`, or `"open"` with no push and no `status`
//      frame yet -- still settling. `isSettling` is true; no fallback.
//   2. Once a `status` frame has landed (still no push), settling is over:
//      `isSettling` flips false -- the caller falls through to the normal
//      current-session view (its own `GET /api/polls` initial fill) -- while
//      a background timer runs.
//   3. A push lands at any point after (1) -- current session confirmed;
//      the caller reads polls from the push from then on. OR: still no push
//      after `NO_SESSION_TIMEOUT_MS` since (2) -- no session is coming;
//      `selectedKey` falls back to the newest race from `GET /api/races`,
//      matching both the dropdown and the polls the caller shows
//      (`RaceSelect`'s placeholder option, in the meantime, keeps the
//      dropdown from ever silently pre-selecting a historical race before
//      this fires).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { useConnection, useSessionMeta, useSessionStatus, useStatusReceived } from "../live/selectors.ts";
import { stringField } from "../lib/format.ts";
import { fetchRaceIndex } from "../races/api.ts";
import type { RaceSelectCurrent } from "../races/RaceSelect.tsx";

export const NO_SESSION_TIMEOUT_MS = 3000;

export interface SelectedRace {
  /** Still settling (phase 1 above) -- the caller should show a connecting
   * placeholder, with no fallback yet. */
  isSettling: boolean;
  /** Whether `selectedKey` is the current session (its polls come from the
   * live push) or a historical race (fetched by key). */
  isCurrentSelected: boolean;
  /** The session_key to show, or null before anything is known. */
  selectedKey: string | null;
  /** `selectedKey` when it names a historical race, else null -- the key a
   * caller should fetch `GET /api/races/:key/polls` for. */
  historicalKey: string | null;
  /** The current session, labelled for `RaceSelect`; null until a session
   * key is known. */
  current: RaceSelectCurrent | null;
  handleRaceChange: (sessionKey: string) => void;
}

export function useSelectedRace(): SelectedRace {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramKey = searchParams.get("race");

  const sessionMeta = useSessionMeta();
  const sessionStatus = useSessionStatus();
  const connection = useConnection();
  const statusReceived = useStatusReceived();

  const currentSessionKey = sessionMeta.sessionKey;

  // Ticks true once the connection is settled (open + at least one status
  // frame) and NO_SESSION_TIMEOUT_MS has passed with still no push and no
  // explicit ?race= -- see the file header. Resets the moment any of those
  // stop holding (a push lands, a param is set, or we lose "settled"): the
  // reset lives in the effect's own cleanup, which React runs right before
  // the next effect instance (or on unmount), rather than in the setup body,
  // so a fresh watch cycle always starts from a clean "not timed out" and no
  // state is set synchronously while the effect is merely (re)arming.
  const settled = connection === "open" && statusReceived;
  const shouldWatchTimeout = paramKey === null && currentSessionKey === null && settled;
  const [noSessionTimedOut, setNoSessionTimedOut] = useState(false);

  useEffect(() => {
    if (!shouldWatchTimeout) return;
    const timer = setTimeout(() => setNoSessionTimedOut(true), NO_SESSION_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      setNoSessionTimedOut(false);
    };
  }, [shouldWatchTimeout]);

  // Same query key as RacesPage's fetch of GET /api/races, so every page
  // shares the cache instead of double-fetching the index.
  const racesQuery = useQuery({ queryKey: ["races"], queryFn: fetchRaceIndex });
  const races = racesQuery.data ?? [];

  // "Settling" is strictly phase 1 (file header): not open yet, or open with
  // no status frame yet. Once a status frame has landed, the caller falls
  // through to the normal current-session view for the rest of the grace
  // period -- `noSessionTimedOut` below is what eventually swaps that for
  // the historical fallback, not this flag.
  const isSettling = paramKey === null && currentSessionKey === null && !settled;
  const fallbackKey = noSessionTimedOut && races[0] !== undefined ? String(races[0].session_key) : null;

  const isCurrentSelected = paramKey === null ? currentSessionKey !== null || fallbackKey === null : paramKey === currentSessionKey;
  const selectedKey = paramKey ?? currentSessionKey ?? fallbackKey;
  const historicalKey = !isCurrentSelected && selectedKey !== null ? selectedKey : null;

  const currentLabel =
    sessionMeta.session !== null
      ? `${stringField(sessionMeta.session, "country") ?? "—"} · ${stringField(sessionMeta.session, "name") ?? "—"}`
      : "Current session";
  const current = currentSessionKey !== null ? { sessionKey: currentSessionKey, label: currentLabel, status: sessionStatus } : null;

  function handleRaceChange(sessionKey: string): void {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("race", sessionKey);
      return next;
    });
  }

  return { isSettling, isCurrentSelected, selectedKey, historicalKey, current, handleRaceChange };
}
