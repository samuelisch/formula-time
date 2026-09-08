// The pure timing board: a two-row toolbar (row 1: lap counter, source
// clock, and caller-supplied controls; row 2: the transport bar, full
// width), race-control and weather cards in a grid, and the full driver
// table. Nothing here is live-only -- every child reads through
// `useBoardState.ts`, so this renders a folded historical push under a
// `BoardSourceProvider` exactly as it renders the live feed (ADR-0009 §5).
//
// The split from `pages/BoardPage.tsx` is by composition, not a flag (issue
// #57 fix round 5): the live route's own furniture -- the finished/upcoming
// banner, polls, and align controls -- all read the *live* session and
// belong to `BoardPage`, which wraps this. `ReplayPage` mounts this directly
// with the transport bar in the `transport` slot, so a replay can never pick
// up a live-only control by accident.
//
// The toolbar's two-row split (issue #81) replaced a single row where the
// delay control used to float mid-row beside the lap counter: row 1 is
// short controls that stay put; row 2 is the shared `TransportBar`, which
// needs the full width for its slider.
import type { ReactNode } from "react";

import { clock } from "../lib/format.ts";
import styles from "./Board.module.css";
import { LapCounter } from "./LapCounter.tsx";
import { RaceControlCard } from "./RaceControlCard.tsx";
import { TimingTable } from "./TimingTable.tsx";
import { TrackStatusStrip } from "./TrackStatusStrip.tsx";
import { useBoardPush } from "./useBoardState.ts";
import { WeatherCard } from "./WeatherCard.tsx";

export interface BoardProps {
  /** Row 1, beside the lap counter and source clock: the live route's polls and align buttons. Absent on a replay. */
  controls?: ReactNode;
  /** Row 2, full width: the shared `TransportBar` (live delay or replay playback). */
  transport?: ReactNode;
  /** A caller-supplied control next to the table: the driver detail panel (issue #90). A right-hand column on wide screens, a full-width card below the table under the narrow breakpoint (Board.module.css). */
  side?: ReactNode;
}

export function Board({ controls, transport, side }: BoardProps = {}) {
  const push = useBoardPush();
  const sourceTime = push === null ? null : push.state.latest_source_time;

  return (
    <div className={styles.board}>
      <TrackStatusStrip />
      <div className={styles.toolbar}>
        <div className={styles.row1}>
          <LapCounter />
          <span className={styles.clock}>{clock(sourceTime)}</span>
          {controls}
        </div>
        {transport !== undefined && <div className={styles.row2}>{transport}</div>}
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
