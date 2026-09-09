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

// Joins: safety car deployment, active_flags as "scope: flag", driver_flags
// as "#num: flag"; "No active flag" when all three are empty.
function flagLine(raceControl: RaceState["race_control"]): string {
  const safetyCar = safetyCarText(raceControl.safety_car);
  const trackFlags = Object.entries(raceControl.active_flags)
    .map(([scope, flag]) => `${scope}: ${flag}`)
    .join(" · ");
  const driverFlags = Object.entries(raceControl.driver_flags)
    .map(([driverNumber, flag]) => `#${driverNumber}: ${flag}`)
    .join(", ");
  return [safetyCar, trackFlags, driverFlags].filter(Boolean).join(" · ") || "No active flag";
}

export function RaceControlCard() {
  const raceControl = useBoardRaceControl();
  const driverCount = useBoardDriverCount();

  return (
    <Card>
      <div className={styles.content}>
        <p className={styles.phase}>{phaseOf(raceControl.session_status, driverCount)}</p>
        <p className={styles.flags}>{flagLine(raceControl)}</p>
      </div>
    </Card>
  );
}
