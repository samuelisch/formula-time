import { memo } from "react";
import type { DriverState, RawRecord } from "@formula-time/domain";

import { number, text } from "../lib/format.ts";
import { useBoardDriver } from "./useBoardState.ts";
import { useDriverSelection } from "./useDriverSelection.ts";
import styles from "./TimingTable.module.css";

function tyreText(tyre: DriverState["tyre"]): string {
  return tyre.compound === null ? "—" : `${tyre.compound} · age ${text(tyre.age)}`;
}

function pitText(pit: RawRecord | null): string {
  return pit === null ? "—" : `L${text(pit["lap_number"])} · ${number(pit["pit_duration"], 1)}s`;
}

export interface DriverRowProps {
  number: number;
}

// Memoised: useBoardDriver() returns the previous reference when this
// driver's data has not changed since the last push, so a push that touches
// one driver re-renders only that driver's row. useDriverSelection() reads
// the URL param directly rather than a prop, so this memoisation still holds
// for every row except the one whose selection just changed (issue #90).
export const DriverRow = memo(function DriverRow({ number: driverNumber }: DriverRowProps) {
  const driver = useBoardDriver(driverNumber);
  const { selected, toggle } = useDriverSelection();
  if (driver === null) return null;

  const isSelected = selected === driverNumber;

  return (
    <tr
      className={isSelected ? `${styles.row} ${styles.selected}` : styles.row}
      onClick={() => toggle(driverNumber)}
      aria-selected={isSelected}
    >
      <td className={styles.position}>{driver.position === null ? "—" : driver.position}</td>
      <td>
        <strong>{text(driver.name_acronym)}</strong>
        <br />
        <span className={styles.muted}>{text(driver.full_name)}</span>
      </td>
      <td>
        <span className={styles.teamDot} style={{ background: `#${text(driver.team_colour, "888")}` }} aria-hidden="true" />
        {text(driver.team_name)}
      </td>
      <td>{number(driver.gap_to_leader, 3)}s</td>
      <td>{number(driver.interval, 3)}s</td>
      <td>{tyreText(driver.tyre)}</td>
      <td>{pitText(driver.latest_pit_stop)}</td>
    </tr>
  );
});
