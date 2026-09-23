import { useState } from "react";
import { Link } from "react-router";

import { AlignPanel } from "../align/AlignPanel.tsx";
import { Board } from "../board/Board.tsx";
import { DriverPanel } from "../board/DriverPanel.tsx";
import { isRacingPush, useBoardIsRacing, useBoardSessionMeta, useBoardSessionStatus } from "../board/useBoardState.ts";
import { ConnectionPill } from "../live/ConnectionPill.tsx";
import { LiveTimelineLoader } from "../live/LiveTimelineLoader.tsx";
import { useLiveSessionKey, useLiveSessionStatus, useStatePush } from "../live/selectors.ts";
import { date, stringField } from "../lib/format.ts";
import { PollModal } from "../polls/PollModal.tsx";
import { PollsButton } from "../polls/PollsButton.tsx";
import { usePolls } from "../polls/usePolls.ts";
import { TimeTargetProvider } from "../transport/TimeTarget.ts";
import { TransportBar } from "../transport/TransportBar.tsx";
import { useLiveTimeTarget } from "../transport/useLiveTimeTarget.ts";
import styles from "./BoardPage.module.css";

interface MountLatch {
  key: number | null;
  mounted: boolean;
}

/**
 * Whether `LiveTimelineLoader` should be mounted for `sessionKey`, latched
 * so a mount persists once racing begins even if racing later turns false
 * -- a rewound viewer must not be yanked to the final state.
 * See README: BoardPage.
 */
function useShouldMountTimelineLoader(sessionKey: number | null, racing: boolean): boolean {
  const [latch, setLatch] = useState<MountLatch>({ key: null, mounted: false });

  if (latch.key !== sessionKey) {
    const mounted = sessionKey !== null && racing;
    setLatch({ key: sessionKey, mounted });
    return mounted;
  }

  if (!latch.mounted && sessionKey !== null && racing) {
    setLatch({ key: sessionKey, mounted: true });
    return true;
  }

  return latch.mounted;
}

// The `/live` route: the pure `Board` (board/Board.tsx) plus everything
// that is live-only -- the finished/upcoming session banner, the
// connection pill, polls, and the alignment control. `ReplayPage` mounts
// `Board` on its own, so none of this leaks onto a replay.
// See README: BoardPage.
export function BoardPage() {
  const polls = usePolls();
  const status = useBoardSessionStatus();
  const { sessionKey, session } = useBoardSessionMeta();
  const target = useLiveTimeTarget();
  const isRacing = useBoardIsRacing();

  const liveSessionKey = useLiveSessionKey();
  const liveSessionStatus = useLiveSessionStatus();
  const statePush = useStatePush();
  const shouldMountTimelineLoader = useShouldMountTimelineLoader(liveSessionKey, isRacingPush(statePush));

  return (
    <div className={styles.page}>
      {status === "finished" && (
        <p className={styles.banner}>
          This race has finished. Showing its final state. <Link to={`/races/${sessionKey}`}>Watch the replay</Link>
        </p>
      )}
      {status === "upcoming" && !isRacing && (
        <p className={styles.banner}>
          Race starts {date(stringField(session ?? {}, "date_start"))}. Timing appears when the session goes live.
        </p>
      )}
      {shouldMountTimelineLoader && liveSessionKey !== null && (
        <LiveTimelineLoader sessionKey={liveSessionKey} status={liveSessionStatus ?? "live"} />
      )}
      <TimeTargetProvider value={target}>
        <Board
          controls={
            <>
              <ConnectionPill />
              <PollsButton />
              {isRacing && <AlignPanel />}
            </>
          }
          transport={isRacing ? <TransportBar /> : undefined}
          side={<DriverPanel />}
        />
      </TimeTargetProvider>
      <PollModal polls={polls} />
    </div>
  );
}
