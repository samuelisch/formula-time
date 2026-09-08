// The pure timing board: lap counter and source clock in a toolbar row, a
// caller-supplied control in the same row, race-control and weather cards in
// a grid, and the full driver table. Nothing here is live-only -- every
// child reads through `useBoardState.ts`, so this renders a folded
// historical push under a `BoardSourceProvider` exactly as it renders the
// live feed (ADR-0009 §5).
//
// The split from `pages/BoardPage.tsx` is by composition, not a flag (issue
// #57 fix round 5): the live route's own furniture -- the finished/upcoming
// banner, polls, the delay and align controls -- all read the *live* session
// and belong to `BoardPage`, which wraps this. `ReplayPage` mounts this
// directly with the transport bar in the toolbar slot, so a replay can never
// pick up a live-only control by accident.
import type { ReactNode } from "react";

import { clock } from "../lib/format.ts";
import styles from "./Board.module.css";
import { LapCounter } from "./LapCounter.tsx";
import { RaceControlCard } from "./RaceControlCard.tsx";
import { TimingTable } from "./TimingTable.tsx";
import { useBoardPush } from "./useBoardState.ts";
import { WeatherCard } from "./WeatherCard.tsx";

export interface BoardProps {
  /** A caller-supplied control dropped into the toolbar row: the live route's polls/delay/align controls, or a replay's transport bar. */
  toolbar?: ReactNode;
  /** A caller-supplied control next to the table: the driver detail panel (issue #90). A right-hand column on wide screens, a full-width card below the table under the narrow breakpoint (Board.module.css). */
  side?: ReactNode;
}

export function Board({ toolbar, side }: BoardProps = {}) {
  const push = useBoardPush();
  const sourceTime = push === null ? null : push.state.latest_source_time;

  return (
    <div className={styles.board}>
      <div className={styles.toolbar}>
        <LapCounter />
        <span className={styles.clock}>{clock(sourceTime)}</span>
        {toolbar}
      </div>
      <div className={styles.grid}>
        <RaceControlCard />
        <WeatherCard />
      </div>
      <div className={styles.tableRow}>
        <div className={styles.tableColumn}>
          <TimingTable />
        </div>
        {/* :empty in CSS collapses this when `side` renders nothing (e.g. DriverPanel with no selection). */}
        <div className={styles.sideColumn}>{side}</div>
      </div>
    </div>
  );
}
