import { Card } from "../components/Card.tsx";
import { DriverRow } from "./DriverRow.tsx";
import { useBoardDriverCount, useBoardDriverOrder, useBoardPositionDeltas } from "./useBoardState.ts";
import { useDriverSelection } from "./useDriverSelection.ts";
import styles from "./TimingTable.module.css";

const COLUMN_COUNT = 8;

export function TimingTable() {
  const order = useBoardDriverOrder();
  // Called once here, not per row: every DriverRow gets `selected` and
  // `delta` as plain props, so only the rows whose own value actually
  // changed re-render (see DriverRow.tsx's memoisation comment).
  const { selected, toggle } = useDriverSelection();
  const deltas = useBoardPositionDeltas();
  const driverCount = useBoardDriverCount();

  return (
    <Card>
      <div className={styles.header}>
        <span>Timing</span>
        <span className={styles.count}>{driverCount} drivers</span>
      </div>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <caption className={styles.visuallyHidden}>Timing, {driverCount} drivers</caption>
          <thead>
            <tr>
              <th scope="col">Pos</th>
              <th scope="col" aria-label="Position change"></th>
              <th scope="col">Driver</th>
              <th scope="col">Team</th>
              <th scope="col">Gap</th>
              <th scope="col">Interval</th>
              <th scope="col">Tyre</th>
              <th scope="col">Last pit</th>
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
