import type { ReactNode } from "react";
import { Link } from "react-router";

import { LapCounter } from "../board/LapCounter.tsx";
import { RaceControlCard } from "../board/RaceControlCard.tsx";
import { TimingTable } from "../board/TimingTable.tsx";
import { useBoardPush, useBoardSessionMeta, useBoardSessionStatus } from "../board/useBoardState.ts";
import { WeatherCard } from "../board/WeatherCard.tsx";
import { clock, date, stringField } from "../lib/format.ts";
import { PollModal } from "../polls/PollModal.tsx";
import { PollsButton } from "../polls/PollsButton.tsx";
import { usePolls } from "../polls/usePolls.ts";
import styles from "./BoardPage.module.css";

export interface BoardPageProps {
  /** A caller-supplied control dropped into the toolbar row, e.g. the delay control (issue #49). */
  toolbar?: ReactNode;
}

// The product's core screen: lap counter and source clock in a toolbar row,
// race-control and weather cards in a grid, and the full driver table.
// Everything here reads through board/useBoardState.ts, never the live store
// directly, so it also renders a folded historical push (ADR-0009).
export function BoardPage({ toolbar }: BoardPageProps = {}) {
  const push = useBoardPush();
  const sourceTime = push === null ? null : push.state.latest_source_time;
  const polls = usePolls();
  const status = useBoardSessionStatus();
  const { sessionKey, session } = useBoardSessionMeta();

  return (
    <div className={styles.board}>
      {status === "finished" && (
        <p className={styles.banner}>
          This race has finished. Showing its final state. <Link to={`/races/${sessionKey}`}>Watch the replay</Link>
        </p>
      )}
      {status === "upcoming" && (
        <p className={styles.banner}>Race starts {date(stringField(session ?? {}, "date_start"))}. Timing appears when the session goes live.</p>
      )}
      <div className={styles.toolbar}>
        <LapCounter />
        <span className={styles.clock}>{clock(sourceTime)}</span>
        <PollsButton />
        {toolbar}
      </div>
      <div className={styles.grid}>
        <RaceControlCard />
        <WeatherCard />
      </div>
      <TimingTable />
      <PollModal polls={polls} />
    </div>
  );
}
