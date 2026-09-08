import { Card } from "../components/Card.tsx";
import { DriverRow } from "./DriverRow.tsx";
import { useBoardDriverOrder, useBoardPush } from "./useBoardState.ts";
import styles from "./TimingTable.module.css";

const COLUMN_COUNT = 7;

export function TimingTable() {
  const order = useBoardDriverOrder();
  const push = useBoardPush();
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
              order.map((driverNumber) => <DriverRow key={driverNumber} number={driverNumber} />)
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
