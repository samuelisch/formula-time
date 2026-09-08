import { Card } from "../components/Card.tsx";
import { StatusLine } from "../components/StatusLine.tsx";
import { useDelay, useLeaderLap, useSessionMeta } from "../live/selectors.ts";

// The timing board itself lands with the next issue. For now this proves the
// live store end to end: the displayed lap and the delay setting.
export function BoardPage() {
  const leaderLap = useLeaderLap();
  const { totalLaps } = useSessionMeta();
  const { delayMs } = useDelay();

  const lapText = totalLaps === null ? "LAP —" : `LAP ${leaderLap}/${totalLaps}`;

  return (
    <Card>
      <StatusLine label="Lap" value={lapText} />
      <StatusLine label="Delay" value={`${Math.round(delayMs / 1000)}s`} />
    </Card>
  );
}
