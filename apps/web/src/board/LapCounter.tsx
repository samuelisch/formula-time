import { useBoardLeaderLap, useBoardSessionMeta } from "./useBoardState.ts";
import styles from "./LapCounter.module.css";

// The viewer's own lap, not the live one -- the live lap would leak how far
// the race really is to a delayed viewer.
function lapText(leaderLap: number, totalLaps: number | null): string {
  if (leaderLap === 0) return "LAP —";
  return totalLaps === null ? `LAP ${leaderLap}` : `LAP ${leaderLap}/${totalLaps}`;
}

export function LapCounter() {
  const leaderLap = useBoardLeaderLap();
  const { totalLaps } = useBoardSessionMeta();

  return <span className={styles.lap}>{lapText(leaderLap, totalLaps)}</span>;
}
