import { useBoardLeaderLap, useBoardSessionMeta } from "./useBoardState.ts";
import styles from "./LapCounter.module.css";

// The viewer's own lap, not the live one -- PRD §4 review note: the live lap
// leaks how far the race really is to a delayed viewer.
function lapText(leaderLap: number, totalLaps: number | null): string {
  if (leaderLap === 0) return "LAP —";
  return totalLaps === null ? `LAP ${leaderLap}` : `LAP ${leaderLap}/${totalLaps}`;
}

export function LapCounter() {
  const leaderLap = useBoardLeaderLap();
  const { totalLaps } = useBoardSessionMeta();

  return <span className={styles.lap}>{lapText(leaderLap, totalLaps)}</span>;
}
