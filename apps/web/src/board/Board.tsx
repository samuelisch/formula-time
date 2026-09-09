// The pure timing board: lap counter and source clock in a toolbar row, a
// caller-supplied control in the same row, the driver-detail `side` slot,
// race-control and weather cards in a grid, and the full driver table.
// Nothing here is live-only -- every child reads through
// `useBoardState.ts`, so this renders a folded historical push under a
// `BoardSourceProvider` exactly as it renders the live feed (ADR-0009 §5).
//
// Layout (issue #90, fix round 1): `side` sits in DOM order right after the
// toolbar -- above the cards and the table -- because that is also its
// *visual* position below the ~860px breakpoint (Board.module.css): a
// full-width card directly under the toolbar, per the issue's acceptance
// criterion. Above the breakpoint, `grid-template-areas` repositions `side`
// next to the table in a final row without moving it in the DOM, so reading
// tab order stays "toolbar, side, cards, table" at every width; only the
// *visual* arrangement changes. This is a single `grid` on `.board`, not two
// copies of `side` -- there is exactly one `side` slot in the tree at any
// width.
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
  /** A caller-supplied control: the driver detail panel (issue #90). A full-width card directly under the toolbar below the ~860px breakpoint; a right-hand column beside the table above it (Board.module.css). */
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
      {/* :empty in CSS collapses this when `side` renders nothing (e.g. DriverPanel with no selection). */}
      <div className={styles.side}>{side}</div>
      <div className={styles.grid}>
        <RaceControlCard />
        <WeatherCard />
      </div>
      <div className={styles.table}>
        <TimingTable />
      </div>
    </div>
  );
}
