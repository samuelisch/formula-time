import { memo } from "react";
import type { DriverState } from "@formula-time/domain";

import { cx } from "../lib/classNames.ts";
import { gapText, pitStopText, text } from "../lib/format.ts";
import { useBoardDriver } from "./useBoardState.ts";
import { TeamDot } from "./TeamDot.tsx";
import styles from "./TimingTable.module.css";

function tyreText(tyre: DriverState["tyre"]): string {
  return tyre.compound === null ? "—" : `${tyre.compound} · age ${text(tyre.age)}`;
}

/** ▲2 (a gain) or ▼1 (a loss); empty for 0 or unknown. */
function cueText(delta: number): string {
  if (delta > 0) return `▲ ${delta}`;
  if (delta < 0) return `▼ ${Math.abs(delta)}`;
  return "";
}

/** `gainClass` for a positive delta, `lossClass` for a negative one, undefined for 0. */
function deltaClass(delta: number, gainClass: string | undefined, lossClass: string | undefined): string | undefined {
  if (delta > 0) return gainClass;
  if (delta < 0) return lossClass;
  return undefined;
}

export interface DriverRowProps {
  number: number;
  /** Places gained (positive) or lost (negative) since the previous push, from useBoardPositionDeltas(); 0 or absent renders no cue. */
  delta?: number;
  /** Whether this driver is the one selected for the detail panel. */
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
// this memoisation for that case. `delta` is likewise a plain number prop
// (not read from a hook here), so the same shallow comparison also skips a
// row whose cue did not change; it also drives a subtle row highlight (not
// just the small cue cell), fading with the arrow since both come from the
// same `delta`.
export const DriverRow = memo(function DriverRow({ number: driverNumber, delta = 0, selected, onSelect }: DriverRowProps) {
  const driver = useBoardDriver(driverNumber);
  if (driver === null) return null;

  const cueClass = deltaClass(delta, styles.cueGain, styles.cueLoss);
  const rowChangeClass = deltaClass(delta, styles.rowGain, styles.rowLoss);
  const rowClassName = cx(styles.row, selected && styles.selected, rowChangeClass);

  return (
    <tr className={rowClassName} onClick={() => onSelect(driverNumber)} aria-selected={selected}>
      <td className={styles.position}>{driver.position === null ? "—" : driver.position}</td>
      <td className={cueClass}>{cueText(delta)}</td>
      <td>
        <strong>{text(driver.name_acronym)}</strong>
        <br />
        <span className={cx(styles.muted, styles.fullName)}>{text(driver.full_name)}</span>
      </td>
      <td>
        <TeamDot teamColour={driver.team_colour} />
        <span className={styles.teamName}>{text(driver.team_name)}</span>
      </td>
      <td>{gapText(driver.gap_to_leader)}</td>
      <td>{gapText(driver.interval)}</td>
      <td>{tyreText(driver.tyre)}</td>
      <td>{pitStopText(driver.latest_pit_stop)}</td>
    </tr>
  );
});
