// Which race PollsPage should show, and whether it's the current session
// or a historical one. Selection lives in the URL (`?race=<session_key>`).
// An explicit `?race=<key>` always wins immediately; with no param, the
// default is "the current session, else the newest race", resolved by
// waiting for a settled signal from the live connection rather than
// racing `GET /api/races` against the first SSE push.
// See README: Polls.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { useConnection, useSessionMeta, useSessionStatus, useStatusReceived } from "../live/selectors.ts";
import { excludeSession, raceTitleDisambiguated } from "../lib/format.ts";
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

  // Ticks true once the connection is settled and NO_SESSION_TIMEOUT_MS has
  // passed with still no push and no explicit ?race=. Resets the moment
  // any of those stop holding; the reset lives in the effect's own
  // cleanup (run before the next instance or on unmount), not the setup
  // body, so a fresh watch cycle always starts clean.
  // See README: Polls.
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

  // The exporter can write a finished session's own index row within
  // seconds, so `races` can already hold the current session's own entry
  // while it is still `displayed` -- excluded here so it never counts as a
  // collision with itself.
  const otherRaces = currentSessionKey === null ? races : excludeSession(races, currentSessionKey);
  const currentLabel = sessionMeta.session !== null ? raceTitleDisambiguated(sessionMeta.session, otherRaces) : "Current session";
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
