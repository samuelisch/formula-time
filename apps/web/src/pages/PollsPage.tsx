// The Polls page organised by race (issue #80). Selection lives in the URL
// (`?race=<session_key>`); no param means "the current session" (the live
// socket's session, whatever it turns out to be) -- that default holds even
// before the session key is known, which is what keeps the pre-push
// initial-fill fallback below working the same as it always has. An
// explicit `?race=<key>` that doesn't (yet) match the known current session
// is treated as a historical race until it does, so a link built before the
// first push resolves on its own once the push lands.
//
// Current-session polls: GET /api/polls only fills the page before the
// first push arrives; once a push has been received, the displayed push's
// polls override it (issue #51 decision) -- so the delayed viewer still
// only sees polls as of their own moment, never the live edge.
//
// This fallback reads live tallies/statuses straight from the api (no delay
// applied) and is safe only because delayMs always starts at 0 (live edge)
// and is never persisted across a reload -- so this window is always "no
// push yet", never "a delayed viewer with no push yet". Whoever persists
// delay (apps/web/AGENTS.md: the ring-buffer/persisted-delay work is a
// post-deploy item) must revisit this: a restored non-zero delay reaching
// this fallback before the first push would show live poll state to a
// viewer who asked to be behind it.
//
// Any other race: `GET /api/races/:session_key/polls` (issue #79's
// contract), `staleTime: 5 min` -- a finished race's polls barely change.
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { apiFetch } from "../api.ts";
import { Card } from "../components/Card.tsx";
import { stringField } from "../lib/format.ts";
import { useDisplayed, useLeaderLap, useSessionMeta, useSessionStatus } from "../live/selectors.ts";
import type { PollPublic } from "../live/types.ts";
import { PollList } from "../polls/PollList.tsx";
import { fetchRaceIndex, fetchRacePolls } from "../races/api.ts";
import { RaceSelect } from "../races/RaceSelect.tsx";
import styles from "./PollsPage.module.css";

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

  const initialFill = useQuery({
    queryKey: ["polls"],
    queryFn: fetchInitialPolls,
    enabled: displayed === null,
  });

  // Same query key as RacesPage's fetch of GET /api/races, so the two pages
  // share the cache instead of double-fetching the index.
  const racesQuery = useQuery({ queryKey: ["races"], queryFn: fetchRaceIndex });
  const races = racesQuery.data ?? [];

  const currentSessionKey = sessionMeta.sessionKey;
  const isCurrentSelected = paramKey === null || paramKey === currentSessionKey;
  const historicalKey = isCurrentSelected ? null : paramKey;

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

  const selectValue = paramKey ?? currentSessionKey ?? (races[0] !== undefined ? String(races[0].session_key) : "");

  function handleRaceChange(sessionKey: string): void {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("race", sessionKey);
      return next;
    });
  }

  const showLapLine = isCurrentSelected && sessionStatus === "live";
  const isUpcoming = isCurrentSelected && sessionStatus === "upcoming";
  const loadingHistorical = !isCurrentSelected && historicalPolls.isLoading;

  return (
    <Card>
      <div className={styles.page}>
        <RaceSelect current={current} races={races} value={selectValue} onChange={handleRaceChange} />

        {showLapLine ? <p className={styles.lapLine}>{lapLineText(leaderLap, sessionMeta.totalLaps)}</p> : null}

        {loadingHistorical ? (
          <p className={styles.quiet}>Loading polls…</p>
        ) : polls.length === 0 ? (
          <div className={styles.empty}>
            <p>No polls for this race</p>
            {isUpcoming ? <p>Polls open on the Friday of the race weekend once the entry list is known</p> : null}
          </div>
        ) : (
          <PollList polls={polls} />
        )}
      </div>
    </Card>
  );
}
