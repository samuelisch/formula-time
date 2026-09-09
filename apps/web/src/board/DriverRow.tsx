import { memo } from "react";
import type { DriverState } from "@formula-time/domain";

import { number, pitStopText, text } from "../lib/format.ts";
import { useBoardDriver } from "./useBoardState.ts";
import { TeamDot } from "./TeamDot.tsx";
import styles from "./TimingTable.module.css";

function tyreText(tyre: DriverState["tyre"]): string {
  return tyre.compound === null ? "—" : `${tyre.compound} · age ${text(tyre.age)}`;
}

export interface DriverRowProps {
  number: number;
  /** Whether this driver is the one selected for the detail panel (issue #90). */
  selected: boolean;
  /** Toggles this driver's selection; called with `number`. Passed down from a single `useDriverSelection()` call in `TimingTable` -- see the memoisation note below. */
  onSelect: (driverNumber: number) => void;
}

// Memoised: useBoardDriver() returns the previous reference when this
// driver's data has not changed since the last push, so a push that touches
// one driver re-renders only that driver's row. `selected` and `onSelect`
// arrive as props from one shared `useDriverSelection()` call in
// `TimingTable`, rather than each row calling the hook itself: every row
// calling `useSearchParams()` directly would re-render all of them on any
// selection change (the URL/location context notifies every subscriber, not
// just the row whose own `selected` value changed), defeating the point of
// this memoisation for that case. With `selected` as a plain boolean prop,
// only the previously-selected and newly-selected rows actually change props
// and re-render (issue #90 fix round 1).
export const DriverRow = memo(function DriverRow({ number: driverNumber, selected, onSelect }: DriverRowProps) {
  const driver = useBoardDriver(driverNumber);
  if (driver === null) return null;

  return (
    <tr
      className={selected ? `${styles.row} ${styles.selected}` : styles.row}
      onClick={() => onSelect(driverNumber)}
      aria-selected={selected}
    >
      <td className={styles.position}>{driver.position === null ? "—" : driver.position}</td>
      <td>
        <strong>{text(driver.name_acronym)}</strong>
        <br />
        <span className={styles.muted}>{text(driver.full_name)}</span>
      </td>
      <td>
        <TeamDot teamColour={driver.team_colour} />
        {text(driver.team_name)}
      </td>
      <td>{number(driver.gap_to_leader, 3)}s</td>
      <td>{number(driver.interval, 3)}s</td>
      <td>{tyreText(driver.tyre)}</td>
      <td>{pitStopText(driver.latest_pit_stop)}</td>
    </tr>
  );
});
