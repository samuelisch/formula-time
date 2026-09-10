import type { RaceState } from "@formula-time/domain";

import { Card } from "../components/Card.tsx";
import { useBoardDriverCount, useBoardRaceControl } from "./useBoardState.ts";
import styles from "./RaceControlCard.module.css";

// The POC's phase rule (poc/ui/app.js renderRaceControl), lifted for the board.
function phaseOf(sessionStatus: string | null, driverCount: number): string {
  if (sessionStatus === null) return "Pre-race · waiting for timing data";
  if (sessionStatus === "SESSION STARTED") {
    return driverCount === 0 ? "Session started · waiting for live timing" : "Race timing live";
  }
  return sessionStatus;
}

function safetyCarText(safetyCar: RaceState["race_control"]["safety_car"]): string {
  if (safetyCar === "VSC") return "Virtual Safety Car (VSC)";
  if (safetyCar === "SC") return "Safety Car (SC)";
  return "";
}

// active_flags as "scope: flag", one line; null when none are active.
function trackFlagsLine(raceControl: RaceState["race_control"]): string | null {
  const entries = Object.entries(raceControl.active_flags);
  if (entries.length === 0) return null;
  return entries.map(([scope, flag]) => `${scope}: ${flag}`).join(" · ");
}

// "#num: flag" for each driver flag, one line; collapsed to "Blue flags: #a,
// #b, ..." when every driver flag is BLUE (the common case, otherwise the
// line grows one entry per driver on track). Null when there are none.
function driverFlagsLine(raceControl: RaceState["race_control"]): string | null {
  const entries = Object.entries(raceControl.driver_flags);
  if (entries.length === 0) return null;
  if (entries.every(([, flag]) => flag === "BLUE")) {
    return `Blue flags: ${entries.map(([driverNumber]) => `#${driverNumber}`).join(", ")}`;
  }
  return entries.map(([driverNumber, flag]) => `#${driverNumber}: ${flag}`).join(", ");
}

export function RaceControlCard() {
  const raceControl = useBoardRaceControl();
  const driverCount = useBoardDriverCount();

  const safetyCar = safetyCarText(raceControl.safety_car) || null;
  const trackFlags = trackFlagsLine(raceControl);
  const driverFlags = driverFlagsLine(raceControl);
  const hasAnyFlag = safetyCar !== null || trackFlags !== null || driverFlags !== null;

  return (
    <Card>
      <div className={styles.content}>
        <p className={styles.phase}>{phaseOf(raceControl.session_status, driverCount)}</p>
        <div className={styles.flags}>
          {hasAnyFlag ? (
            <>
              {safetyCar !== null && <p>{safetyCar}</p>}
              {trackFlags !== null && <p>{trackFlags}</p>}
              {driverFlags !== null && <p>{driverFlags}</p>}
            </>
          ) : (
            <p>No active flag</p>
          )}
        </div>
      </div>
    </Card>
  );
}
