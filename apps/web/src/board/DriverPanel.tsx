// The driver detail side panel (issue #90): reads only `useBoardDriver()`
// and `useBoardSessionMeta()` through the board seam, so it renders a live
// push and a folded replay push identically, and `useDriverSelection()` for
// which driver (and Escape to clear) -- never the live store or the URL
// directly. Mounted unconditionally in `Board`'s `side` slot; renders
// nothing when no driver is selected or the selection is not in the current
// push (e.g. a stale `?driver=` after a session change).
import { useEffect } from "react";
import type { RawRecord } from "@formula-time/domain";

import { Card } from "../components/Card.tsx";
import { lapTime, number, text } from "../lib/format.ts";
import styles from "./DriverPanel.module.css";
import { useBoardDriver, useBoardSessionMeta } from "./useBoardState.ts";
import { useDriverSelection } from "./useDriverSelection.ts";

function lapText(currentLap: number | null, totalLaps: number | null): string {
  if (currentLap === null) return "—";
  return totalLaps === null ? String(currentLap) : `${currentLap}/${totalLaps}`;
}

function pitOutText(isPitOutLap: boolean | null): string {
  if (isPitOutLap === null) return "—";
  return isPitOutLap ? "Yes" : "No";
}

// Fix round 1 (issue #90 review): number(value, 3) + a literal "s" appended
// outside it rendered "—s" for a null gap/interval (the race leader's gap,
// for one) instead of the issue's verbatim "missing values render —" -- the
// "s" suffix has to be conditional on there being a number to suffix.
function secondsText(value: number | null): string {
  return value === null ? "—" : `${number(value, 3)}s`;
}

function pitStopLine(pit: RawRecord): string {
  return `L${text(pit["lap_number"])} · ${number(pit["pit_duration"], 1)}s`;
}

export function DriverPanel() {
  const { selected, clear } = useDriverSelection();
  const driver = useBoardDriver(selected ?? -1);
  const { totalLaps } = useBoardSessionMeta();

  useEffect(() => {
    if (selected === null) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") clear();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, clear]);

  if (selected === null || driver === null) return null;

  const pitStopsNewestFirst = [...driver.pit_stops].reverse();

  return (
    <Card>
      <div className={styles.header}>
        <span className={styles.position}>{text(driver.position)}</span>
        <div>
          <strong>{text(driver.name_acronym)}</strong>
          <div className={styles.muted}>{text(driver.full_name)}</div>
        </div>
      </div>
      <div className={styles.team}>
        <span className={styles.teamDot} style={{ background: `#${text(driver.team_colour, "888")}` }} aria-hidden="true" />
        {text(driver.team_name)}
      </div>
      <dl className={styles.stats}>
        <dt>Gap</dt>
        <dd>{secondsText(driver.gap_to_leader)}</dd>
        <dt>Interval</dt>
        <dd>{secondsText(driver.interval)}</dd>
        <dt>Lap</dt>
        <dd>{lapText(driver.current_lap, totalLaps)}</dd>
        <dt>Last lap</dt>
        <dd>{lapTime(driver.lap_duration)}</dd>
        <dt>Sector 1</dt>
        <dd>{lapTime(driver.sector_durations.sector_1)}</dd>
        <dt>Sector 2</dt>
        <dd>{lapTime(driver.sector_durations.sector_2)}</dd>
        <dt>Sector 3</dt>
        <dd>{lapTime(driver.sector_durations.sector_3)}</dd>
        <dt>Pit-out lap</dt>
        <dd>{pitOutText(driver.is_pit_out_lap)}</dd>
      </dl>
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Tyre</h3>
        <dl className={styles.stats}>
          <dt>Compound</dt>
          <dd>{text(driver.tyre.compound)}</dd>
          <dt>Stint</dt>
          <dd>{text(driver.tyre.stint_number)}</dd>
          <dt>Lap started</dt>
          <dd>{text(driver.tyre.lap_start)}</dd>
          <dt>Age</dt>
          <dd>{text(driver.tyre.age)}</dd>
        </dl>
      </div>
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Pit stops</h3>
        {pitStopsNewestFirst.length === 0 ? (
          <p className={styles.muted}>No pit stops yet.</p>
        ) : (
          <ul className={styles.pitList}>
            {pitStopsNewestFirst.map((pit, index) => (
              <li key={text(pit["event_id"], String(index))}>{pitStopLine(pit)}</li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
