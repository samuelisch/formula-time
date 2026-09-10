// The chooser: the landing page (`/`) -- a "Live now" card when the live
// store holds a session (linking to `/live`), then the historical list from
// `GET /api/races` (newest first as served), each row linking to its
// replay at `/races/:session_key`.
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { Card } from "../components/Card.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { date, stringField, text } from "../lib/format.ts";
import { useDisplayed, useSessionStatus } from "../live/selectors.ts";
import { fetchRaceIndex } from "../races/api.ts";
import styles from "./RacesPage.module.css";

export function RacesPage() {
  const displayed = useDisplayed();
  const status = useSessionStatus();
  const liveSession = displayed?.state.session ?? null;
  const liveTotalLaps = displayed?.total_laps ?? null;
  const liveSessionKey = displayed?.session_key ?? null;

  const racesQuery = useQuery({
    queryKey: ["races"],
    queryFn: fetchRaceIndex,
  });
  const data = racesQuery.data;

  function heroCard(): ReactNode {
    if (status === "live" && liveSession !== null) {
      return (
        <Link to="/live" className={styles.liveCard}>
          <span className={styles.liveBadge}>Live now</span>
          <span className={styles.liveDetails}>
            {stringField(liveSession, "country") ?? "—"} · {stringField(liveSession, "name") ?? "—"} ·{" "}
            {date(stringField(liveSession, "date_start"))} · {text(liveTotalLaps)} laps
          </span>
        </Link>
      );
    }

    if (status === "upcoming" && liveSession !== null) {
      return (
        <Link to="/live" className={styles.nextCard}>
          Next race · {stringField(liveSession, "country") ?? "—"} · {stringField(liveSession, "name") ?? "—"} ·{" "}
          {date(stringField(liveSession, "date_start"))}
        </Link>
      );
    }

    if (status === "finished" && liveSession !== null && liveSessionKey !== null) {
      return (
        <div className={styles.finishedCard}>
          <span className={styles.finishedLabel}>
            Last session · {stringField(liveSession, "country") ?? "—"} · {stringField(liveSession, "name") ?? "—"} · finished
          </span>
          <span className={styles.finishedLinks}>
            <Link to="/live">Final state</Link>
            <Link to={`/races/${liveSessionKey}`}>Watch the replay</Link>
          </span>
        </div>
      );
    }

    return <p className={styles.quiet}>No live session right now</p>;
  }

  return (
    <div className={styles.races}>
      <Card>{heroCard()}</Card>

      <section>
        <h2 className={styles.heading}>Past races</h2>
        <QueryState
          status={racesQuery.status}
          error={racesQuery.error}
          onRetry={() => void racesQuery.refetch()}
          loadingText="Loading races…"
          errorText="Could not load past races"
        >
          {data !== undefined && data.length === 0 ? (
            <p className={styles.quiet}>No past races yet</p>
          ) : (
            <ul className={styles.list}>
              {(data ?? []).map((race) => (
                <li key={race.session_key}>
                  <Link to={`/races/${race.session_key}`} className={styles.raceRow}>
                    <span>
                      {race.country} · {race.name}
                    </span>
                    <span className={styles.raceMeta}>
                      {date(race.date_start)} · {text(race.total_laps)} laps
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </section>
    </div>
  );
}
