// The chooser: the landing page (`/`). Owner ask on issue #57 -- a "Live
// now" card when the live store holds a session (linking to `/live`), then
// the historical list from `GET /api/races` (newest first as served), each
// row linking to its replay at `/races/:session_key`.
import { useQuery } from "@tanstack/react-query";
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

  const racesQuery = useQuery({
    queryKey: ["races"],
    queryFn: fetchRaceIndex,
  });
  const data = racesQuery.data;

  return (
    <div className={styles.races}>
      <Card>
        {status === "live" && liveSession !== null ? (
          <Link to="/live" className={styles.liveCard}>
            <span className={styles.liveBadge}>Live now</span>
            <span className={styles.liveDetails}>
              {stringField(liveSession, "country") ?? "—"} · {stringField(liveSession, "name") ?? "—"} ·{" "}
              {date(stringField(liveSession, "date_start"))} · {text(liveTotalLaps)} laps
            </span>
          </Link>
        ) : status === "upcoming" && liveSession !== null ? (
          <Link to="/live" className={styles.nextCard}>
            Next race · {stringField(liveSession, "country") ?? "—"} · {stringField(liveSession, "name") ?? "—"} ·{" "}
            {date(stringField(liveSession, "date_start"))}
          </Link>
        ) : (
          <p className={styles.quiet}>No live session right now</p>
        )}
      </Card>

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
