import { useState } from "react";
import { Link } from "react-router";

import { AlignPanel } from "../align/AlignPanel.tsx";
import { Board } from "../board/Board.tsx";
import { DriverPanel } from "../board/DriverPanel.tsx";
import { useBoardSessionMeta, useBoardSessionStatus } from "../board/useBoardState.ts";
import { LiveTimelineLoader } from "../live/LiveTimelineLoader.tsx";
import { useLiveSessionKey, useLiveSessionStatus, type SessionStatusValue } from "../live/selectors.ts";
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
 * Whether `LiveTimelineLoader` should be mounted for `sessionKey`, latched:
 * once mounted for a session key it stays mounted while that key remains
 * the live session, even after `status` becomes "finished" -- a viewer
 * rewound deep into the race at the chequered flag must not be yanked to
 * the final state (the spoiler rule: everything renders from the displayed,
 * rewound state). It never mounts for "upcoming", and never for a session
 * that was already "finished" the first time this saw it (that session's
 * banner points at the replay instead).
 *
 * React's "adjust state during render" pattern (as `useBoardDriver` in
 * `board/useBoardState.ts` uses), not a ref: comparing state to the current
 * `sessionKey` during render, and calling `setState` during render when it
 * differs, causes React to redo this render immediately with the new state
 * before anything commits or paints.
 */
function useShouldMountTimelineLoader(sessionKey: number | null, status: SessionStatusValue | null): boolean {
  const [latch, setLatch] = useState<MountLatch>({ key: null, mounted: false });

  if (latch.key !== sessionKey) {
    const mounted = sessionKey !== null && status === "live";
    setLatch({ key: sessionKey, mounted });
    return mounted;
  }

  if (!latch.mounted && sessionKey !== null && status === "live") {
    setLatch({ key: sessionKey, mounted: true });
    return true;
  }

  return latch.mounted;
}

// The `/live` route: the pure `Board` (board/Board.tsx) plus everything
// that is live-only -- the finished/upcoming session banner, polls, and the
// alignment control. `ReplayPage` mounts `Board` on its own, so none of
// this leaks onto a replay: the banner would read the replay's own
// session, which is always finished (the exporter only exports finished
// sessions), and the transport bar's live `TimeTarget` acts on the live
// store's push buffer, which a replay does not use.
//
// `TransportBar` is driven by `useLiveTimeTarget()` through the
// `TimeTarget` seam rather than the live store directly, so `AlignPanel`
// (via `useAligner`) is routed through the same seam and can also mount on
// a replay (`ReplayPage.tsx`) -- one `TimeTargetProvider` wraps the whole
// `Board`, not just `TransportBar`, so both slots read the same target.
//
// `LiveTimelineLoader` (issue #97) is mounted here, keyed off the *live*
// push's own session key/status (`useLiveSessionKey`/`useLiveSessionStatus`)
// -- never the *displayed* session, which in timeline mode is the
// synthesised push and would feed the loader its own output back in.
export function BoardPage() {
  const polls = usePolls();
  const status = useBoardSessionStatus();
  const { sessionKey, session } = useBoardSessionMeta();
  const target = useLiveTimeTarget();

  const liveSessionKey = useLiveSessionKey();
  const liveSessionStatus = useLiveSessionStatus();
  const shouldMountTimelineLoader = useShouldMountTimelineLoader(liveSessionKey, liveSessionStatus);

  return (
    <div className={styles.page}>
      {status === "finished" && (
        <p className={styles.banner}>
          This race has finished. Showing its final state. <Link to={`/races/${sessionKey}`}>Watch the replay</Link>
        </p>
      )}
      {status === "upcoming" && (
        <p className={styles.banner}>Race starts {date(stringField(session ?? {}, "date_start"))}. Timing appears when the session goes live.</p>
      )}
      {shouldMountTimelineLoader && liveSessionKey !== null && (
        <LiveTimelineLoader sessionKey={liveSessionKey} status={liveSessionStatus ?? "live"} />
      )}
      <TimeTargetProvider value={target}>
        <Board
          controls={
            <>
              <PollsButton />
              <AlignPanel />
            </>
          }
          transport={<TransportBar />}
          side={<DriverPanel />}
        />
      </TimeTargetProvider>
      <PollModal polls={polls} />
    </div>
  );
}
