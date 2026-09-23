// The pure timing board: a two-row toolbar, the driver-detail `side` slot,
// race-control and weather cards, and the driver table. Nothing here is
// live-only -- every child reads through `useBoardState.ts`, so this
// renders a folded historical push under a `BoardSourceProvider` exactly
// as it renders the live feed (ADR-0009 §5).
// See README: Board layout.
import type { ReactNode } from "react";

import { clock } from "../lib/format.ts";
import styles from "./Board.module.css";
import { LapCounter } from "./LapCounter.tsx";
import { RaceControlCard } from "./RaceControlCard.tsx";
import { RaceControlFeed } from "./RaceControlFeed.tsx";
import { TimingTable } from "./TimingTable.tsx";
import { TrackStatusStrip } from "./TrackStatusStrip.tsx";
import { useBoardIsReplay, useBoardPush } from "./useBoardState.ts";
import { WeatherCard } from "./WeatherCard.tsx";

export interface BoardProps {
  /** Row 1, beside the lap counter and source clock: the live route's polls and align buttons. Absent on a replay. */
  controls?: ReactNode;
  /** Row 2, full width: the shared `TransportBar` (live delay or replay playback). */
  transport?: ReactNode;
  /** A caller-supplied control: the driver detail panel. A full-width card directly under the toolbar below the ~860px breakpoint; a right-hand column beside the table above it (Board.module.css). */
  side?: ReactNode;
}

export function Board({ controls, transport, side }: BoardProps = {}) {
  const push = useBoardPush();
  const sourceTime = push === null ? null : push.state.latest_source_time;
  const isReplay = useBoardIsReplay();

  return (
    <div className={styles.board}>
      {/* :empty in CSS collapses this when TrackStatusStrip renders nothing (the track is green). Needs its own named grid area (below) same as `side` -- an unnamed grid child would auto-place into an implicit row instead of the top. */}
      <div className={styles.stripArea}>
        <TrackStatusStrip />
      </div>
      <div className={styles.toolbar}>
        <div className={styles.row1}>
          <LapCounter />
          <span className={styles.clock} data-testid="source-clock">
            {clock(sourceTime)}
          </span>
          {controls}
        </div>
        {transport !== undefined && <div className={styles.row2}>{transport}</div>}
      </div>
      {/* :empty in CSS collapses this when `side` renders nothing (e.g. DriverPanel with no selection). */}
      <div className={styles.side}>{side}</div>
      <div className={styles.grid}>
        <RaceControlCard />
        <WeatherCard />
        <RaceControlFeed defaultOpen={isReplay} />
      </div>
      <div className={styles.table}>
        <TimingTable />
      </div>
    </div>
  );
}
