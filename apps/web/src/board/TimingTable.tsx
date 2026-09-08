import { Card } from "../components/Card.tsx";
import { DriverRow } from "./DriverRow.tsx";
import { useBoardDriverOrder, useBoardPositionDeltas, useBoardPush } from "./useBoardState.ts";
import { useDriverSelection } from "./useDriverSelection.ts";
import styles from "./TimingTable.module.css";

const COLUMN_COUNT = 8;

export function TimingTable() {
  const order = useBoardDriverOrder();
  const push = useBoardPush();
  // Called once here, not per row: every DriverRow gets `selected` as a
  // plain boolean prop, so only the rows whose selection actually changed
  // re-render (issue #90 fix round 1 -- see DriverRow.tsx's comment).
  const { selected, toggle } = useDriverSelection();
  // Likewise computed once here (not per row) so every row shares one
  // baseline; DriverRow reads its own driver's entry as a plain number prop
  // (issue #91).
  const deltas = useBoardPositionDeltas();
  const driverCount = push === null ? 0 : Object.keys(push.state.drivers).length;

  return (
    <Card>
      <div className={styles.header}>
        <span>Timing</span>
        <span className={styles.count}>{driverCount} drivers</span>
      </div>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Pos</th>
              <th aria-label="Position change"></th>
              <th>Driver</th>
              <th>Team</th>
              <th>Gap</th>
              <th>Interval</th>
              <th>Tyre</th>
              <th>Last pit</th>
            </tr>
          </thead>
          <tbody>
            {order.length === 0 ? (
              <tr>
                <td className={styles.empty} colSpan={COLUMN_COUNT}>
                  Waiting for race state…
                </td>
              </tr>
            ) : (
              order.map((driverNumber) => (
                <DriverRow
                  key={driverNumber}
                  number={driverNumber}
                  delta={deltas[driverNumber] ?? 0}
                  selected={selected === driverNumber}
                  onSelect={toggle}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
