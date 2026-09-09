// A full-width coloured band above the board's toolbar, present only when
// the track is not green. Reads `race_control.active_flags`, `.safety_car`,
// `.current_flag`, and `isChequered(state)` through the board seam
// (`useBoardState.ts`), so the same strip renders for the live feed and for
// a folded replay push, and never leaks a result a delayed viewer's own lap
// has not reached yet.
import { isChequered } from "@formula-time/domain";
import type { RaceState } from "@formula-time/domain";

import { useBoardPush, useBoardRaceControl } from "./useBoardState.ts";
import styles from "./TrackStatusStrip.module.css";

type StripKind = "red" | "safetyCar" | "vsc" | "chequered" | "yellow";

interface Strip {
  kind: StripKind;
  text: string;
}

// active_flags keys are `scope` or `${scope}:${sector}` (race_state.ts
// applyRaceControl); render the colon as a space, e.g. "Sector:4" -> "Sector 4".
function formatScope(key: string): string {
  return key.replace(":", " ");
}

// Priority order, one strip only:
// RED FLAG > SAFETY CAR > VIRTUAL SAFETY CAR > CHEQUERED FLAG > YELLOW · sectors {list} > nothing.
function computeStrip(raceControl: RaceState["race_control"], chequered: boolean): Strip | null {
  const flags = raceControl.active_flags;

  if (Object.values(flags).includes("RED")) {
    return { kind: "red", text: "RED FLAG" };
  }
  if (raceControl.safety_car === "SC") {
    return { kind: "safetyCar", text: "SAFETY CAR" };
  }
  if (raceControl.safety_car === "VSC") {
    return { kind: "vsc", text: "VIRTUAL SAFETY CAR" };
  }
  if (chequered) {
    return { kind: "chequered", text: "CHEQUERED FLAG" };
  }

  const yellowScopes = Object.entries(flags)
    .filter(([, flag]) => flag === "YELLOW")
    .map(([scope]) => formatScope(scope));
  if (yellowScopes.length > 0) {
    return { kind: "yellow", text: `YELLOW · sectors ${yellowScopes.join(", ")}` };
  }

  return null;
}

export function TrackStatusStrip() {
  const push = useBoardPush();
  const raceControl = useBoardRaceControl();
  const chequered = push !== null && isChequered(push.state);
  const strip = computeStrip(raceControl, chequered);

  if (strip === null) return null;

  return (
    <div className={`${styles.strip} ${styles[strip.kind]}`} role="status">
      {strip.text}
    </div>
  );
}
