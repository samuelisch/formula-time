// The Polls page organised by race (issue #80). Selection lives in the URL
// (`?race=<session_key>`).
//
// An explicit `?race=<key>` always wins, immediately -- it is fetched via
// `fetchRacePolls` regardless of whether the current session is known yet,
// and self-heals to "current" once a push confirms a matching session key.
//
// With no param, the default is "the current session, else the newest
// race" (issue #80's spec) -- but "no current session is known yet" is
// ambiguous on its own: it means both "the session hasn't pushed its first
// state" (transient, resolves in moments) and "there genuinely is no
// session" (session-lifecycle.ts's `pickSession() === null`, e.g.
// off-season). Fix round 2 on PR #85's review: inferring the difference
// from `sessionKey === null` alone raced `GET /api/races` against the
// first SSE push and could show a wrong, unrelated race's polls. Instead
// this page waits for a settled signal from the live connection:
//   1. `connection !== "open"`, or `"open"` with no push and no `status`
//      frame yet -- still settling. Shows "Connecting…"; no fallback.
//   2. Once a `status` frame has landed (still no push), settling is over:
//      the page falls through to the normal current-session view -- the
//      `GET /api/polls` initial fill (issue #51) -- while a background
//      timer runs.
//   3. A push lands at any point after (1) -- current session confirmed;
//      polls come from the push from then on. OR: still no push after
//      `NO_SESSION_TIMEOUT_MS` since (2) -- no session is coming; falls
//      back to the newest race from `GET /api/races`, matching both the
//      dropdown and the polls shown (RaceSelect's placeholder option, in
//      the meantime, keeps the dropdown from ever silently pre-selecting a
//      historical race before this fires).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";

import { apiFetch } from "../api.ts";
import { Card } from "../components/Card.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { stringField } from "../lib/format.ts";
import { useConnection, useDisplayed, useLeaderLap, useSessionMeta, useSessionStatus, useStatusReceived } from "../live/selectors.ts";
import type { PollPublic } from "../live/types.ts";
import { PollList } from "../polls/PollList.tsx";
import { fetchRaceIndex, fetchRacePolls } from "../races/api.ts";
import { RaceSelect } from "../races/RaceSelect.tsx";
import styles from "./PollsPage.module.css";

export const NO_SESSION_TIMEOUT_MS = 3000;

async function fetchInitialPolls(): Promise<PollPublic[]> {
  const response = await apiFetch("/api/polls");
  if (!response.ok) throw new Error("Failed to load polls");
  return (await response.json()) as PollPublic[];
}

// Deliberately not board/LapCounter's lapText: that file is owned by issue
// #81's board slice for this wave, and this page's line never needs the
// "LAP —" (leader hasn't started a lap) case LapCounter has, since it only
// renders once the session is confirmed live.
function lapLineText(leaderLap: number, totalLaps: number | null): string {
  return totalLaps === null ? `LAP ${leaderLap}` : `LAP ${leaderLap}/${totalLaps}`;
}

export function PollsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramKey = searchParams.get("race");

  const displayed = useDisplayed();
  const sessionMeta = useSessionMeta();
  const sessionStatus = useSessionStatus();
  const leaderLap = useLeaderLap();
  const connection = useConnection();
  const statusReceived = useStatusReceived();

  const currentSessionKey = sessionMeta.sessionKey;

  // Ticks true once the connection is settled (open + at least one status
  // frame) and NO_SESSION_TIMEOUT_MS has passed with still no push and no
  // explicit ?race= -- see the file header. Resets the moment any of those
  // stop holding (a push lands, a param is set, or we lose "settled").
  const settled = connection === "open" && statusReceived;
  const shouldWatchTimeout = paramKey === null && currentSessionKey === null && settled;
  const [noSessionTimedOut, setNoSessionTimedOut] = useState(false);

  useEffect(() => {
    if (!shouldWatchTimeout) {
      setNoSessionTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setNoSessionTimedOut(true), NO_SESSION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [shouldWatchTimeout]);

  const initialFill = useQuery({
    queryKey: ["polls"],
    queryFn: fetchInitialPolls,
    enabled: displayed === null,
  });

  // Same query key as RacesPage's fetch of GET /api/races, so the two pages
  // share the cache instead of double-fetching the index.
  const racesQuery = useQuery({ queryKey: ["races"], queryFn: fetchRaceIndex });
  const races = racesQuery.data ?? [];

  // "Settling" is strictly phase 1 (file header): not open yet, or open with
  // no status frame yet. Once a status frame has landed, the page falls
  // through to the normal current-session view (the initial-fill fallback)
  // for the rest of the grace period -- `noSessionTimedOut` below is what
  // eventually swaps that for the historical fallback, not this flag.
  const isSettling = paramKey === null && currentSessionKey === null && !settled;
  const fallbackKey = noSessionTimedOut && races[0] !== undefined ? String(races[0].session_key) : null;

  const isCurrentSelected = paramKey === null ? currentSessionKey !== null || fallbackKey === null : paramKey === currentSessionKey;
  const selectedKey = paramKey ?? currentSessionKey ?? fallbackKey;
  const historicalKey = !isCurrentSelected && selectedKey !== null ? selectedKey : null;

  const historicalPolls = useQuery({
    queryKey: ["race-polls", historicalKey],
    queryFn: () => fetchRacePolls(historicalKey as string),
    staleTime: 5 * 60 * 1000,
    enabled: historicalKey !== null,
  });

  const currentPolls = displayed !== null ? displayed.polls : (initialFill.data ?? []);
  const polls = isCurrentSelected ? currentPolls : (historicalPolls.data ?? []);

  const currentLabel =
    sessionMeta.session !== null
      ? `${stringField(sessionMeta.session, "country") ?? "—"} · ${stringField(sessionMeta.session, "name") ?? "—"}`
      : "Current session";

  const current = currentSessionKey !== null ? { sessionKey: currentSessionKey, label: currentLabel, status: sessionStatus } : null;

  const selectValue = selectedKey ?? "";

  function handleRaceChange(sessionKey: string): void {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("race", sessionKey);
      return next;
    });
  }

  const showLapLine = isCurrentSelected && sessionStatus === "live";
  const isUpcoming = isCurrentSelected && sessionStatus === "upcoming";

  function emptyState(): ReactNode {
    return (
      <div className={styles.empty}>
        <p>No polls for this race</p>
        {isUpcoming ? <p>Polls open on the Friday of the race weekend once the entry list is known</p> : null}
      </div>
    );
  }

  return (
    <Card>
      <div className={styles.page}>
        <RaceSelect current={current} races={races} value={selectValue} onChange={handleRaceChange} />

        {showLapLine ? <p className={styles.lapLine}>{lapLineText(leaderLap, sessionMeta.totalLaps)}</p> : null}

        {isSettling ? (
          <p className={styles.quiet}>Connecting…</p>
        ) : isCurrentSelected ? (
          // The current session's polls come straight from the push (or the
          // pre-first-push GET /api/polls fallback) -- neither is a
          // useQuery in the failed-fetch sense issue #94 is about, so this
          // path stays outside QueryState.
          polls.length === 0 ? (
            emptyState()
          ) : (
            <PollList polls={polls} />
          )
        ) : (
          <QueryState
            status={historicalPolls.status}
            error={historicalPolls.error}
            onRetry={() => void historicalPolls.refetch()}
            loadingText="Loading polls…"
            errorText="Could not load polls for this race"
          >
            {(historicalPolls.data ?? []).length === 0 ? emptyState() : <PollList polls={historicalPolls.data ?? []} />}
          </QueryState>
        )}
      </div>
    </Card>
  );
}
