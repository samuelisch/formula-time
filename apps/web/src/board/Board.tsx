// The pure timing board: a two-row toolbar (row 1: lap counter, source
// clock, and caller-supplied controls; row 2: the transport bar, full
// width), the driver-detail `side` slot, race-control and weather cards in
// a grid, and the full driver table. Nothing here is live-only -- every
// child reads through `useBoardState.ts`, so this renders a folded
// historical push under a `BoardSourceProvider` exactly as it renders the
// live feed (ADR-0009 §5).
//
// Layout (issue #90, fix round 1): `side` sits in DOM order right after the
// toolbar -- above the cards and the table -- because that is also its
// *visual* position below the ~860px breakpoint (Board.module.css): a
// full-width card directly under the (whole, two-row) toolbar, per the
// issue's acceptance criterion. Above the breakpoint, `grid-template-areas`
// repositions `side` next to the table in a final row without moving it in
// the DOM, so reading/tab order stays "toolbar, side, cards, table" at
// every width; only the *visual* arrangement changes. This is a single
// `grid` on `.board`, not two copies of `side` -- there is exactly one
// `side` slot in the tree at any width.
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
  /** A caller-supplied control: the driver detail panel (issue #90). A full-width card directly under the toolbar below the ~860px breakpoint; a right-hand column beside the table above it (Board.module.css). */
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
          <span className={styles.clock}>{clock(sourceTime)}</span>
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
