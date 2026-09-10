// The Polls page organised by race. Race selection (the URL param, the
// settling/fallback rules) lives in `useSelectedRace`; this file renders
// from it.
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { apiFetch } from "../api.ts";
import { Card } from "../components/Card.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { useDisplayed, useLeaderLap, useSessionMeta, useSessionStatus } from "../live/selectors.ts";
import type { PollPublic } from "../live/types.ts";
import { PollList } from "../polls/PollList.tsx";
import { useSelectedRace } from "../polls/useSelectedRace.ts";
import { fetchRaceIndex, fetchRacePolls } from "../races/api.ts";
import { RaceSelect } from "../races/RaceSelect.tsx";
import styles from "./PollsPage.module.css";

export { NO_SESSION_TIMEOUT_MS } from "../polls/useSelectedRace.ts";

async function fetchInitialPolls(): Promise<PollPublic[]> {
  const response = await apiFetch("/api/polls");
  if (!response.ok) throw new Error("Failed to load polls");
  return (await response.json()) as PollPublic[];
}

// Deliberately not board/LapCounter's lapText: this page's line never needs
// the "LAP —" (leader hasn't started a lap) case LapCounter has, since it
// only renders once the session is confirmed live.
function lapLineText(leaderLap: number, totalLaps: number | null): string {
  return totalLaps === null ? `LAP ${leaderLap}` : `LAP ${leaderLap}/${totalLaps}`;
}

export function PollsPage() {
  const { isSettling, isCurrentSelected, selectedKey, historicalKey, current, handleRaceChange } = useSelectedRace();

  const displayed = useDisplayed();
  const sessionMeta = useSessionMeta();
  const sessionStatus = useSessionStatus();
  const leaderLap = useLeaderLap();

  const initialFill = useQuery({
    queryKey: ["polls"],
    queryFn: fetchInitialPolls,
    enabled: displayed === null,
  });

  // Same query key as useSelectedRace's and RacesPage's fetch of
  // GET /api/races, so every page shares the cache instead of
  // double-fetching the index.
  const racesQuery = useQuery({ queryKey: ["races"], queryFn: fetchRaceIndex });
  const races = racesQuery.data ?? [];

  const historicalPolls = useQuery({
    queryKey: ["race-polls", historicalKey],
    queryFn: () => fetchRacePolls(historicalKey as string),
    staleTime: 5 * 60 * 1000,
    enabled: historicalKey !== null,
  });

  const currentPolls = displayed !== null ? displayed.polls : (initialFill.data ?? []);
  const polls = isCurrentSelected ? currentPolls : (historicalPolls.data ?? []);

  const selectValue = selectedKey ?? "";

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

  function pollsContent(): ReactNode {
    if (isSettling) {
      return <p className={styles.quiet}>Connecting…</p>;
    }

    if (isCurrentSelected) {
      // The current session's polls come straight from the push (or the
      // pre-first-push GET /api/polls fallback) -- neither is a useQuery in
      // the failed-fetch sense QueryState is for, so this path stays
      // outside it.
      return polls.length === 0 ? emptyState() : <PollList polls={polls} />;
    }

    return (
      <QueryState
        status={historicalPolls.status}
        error={historicalPolls.error}
        onRetry={() => void historicalPolls.refetch()}
        loadingText="Loading polls…"
        errorText="Could not load polls for this race"
      >
        {(historicalPolls.data ?? []).length === 0 ? emptyState() : <PollList polls={historicalPolls.data ?? []} />}
      </QueryState>
    );
  }

  return (
    <Card>
      <div className={styles.page}>
        <RaceSelect current={current} races={races} value={selectValue} onChange={handleRaceChange} />

        {showLapLine ? <p className={styles.lapLine}>{lapLineText(leaderLap, sessionMeta.totalLaps)}</p> : null}

        {pollsContent()}
      </div>
    </Card>
  );
}
