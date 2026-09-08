import { Link } from "react-router";

import { AlignPanel } from "../align/AlignPanel.tsx";
import { Board } from "../board/Board.tsx";
import { DriverPanel } from "../board/DriverPanel.tsx";
import { useBoardSessionMeta, useBoardSessionStatus } from "../board/useBoardState.ts";
import { date, stringField } from "../lib/format.ts";
import { PollModal } from "../polls/PollModal.tsx";
import { PollsButton } from "../polls/PollsButton.tsx";
import { usePolls } from "../polls/usePolls.ts";
import { TimeTargetProvider } from "../transport/TimeTarget.ts";
import { TransportBar } from "../transport/TransportBar.tsx";
import { useLiveTimeTarget } from "../transport/useLiveTimeTarget.ts";
import styles from "./BoardPage.module.css";

// The `/live` route: the pure `Board` (board/Board.tsx) plus everything that
// is live-only -- the finished/upcoming session banner, polls, and the
// alignment control. `ReplayPage` mounts `Board` on its own, so none of this
// can leak onto a replay (issue #57 fix round 5): the banner would read the
// replay's own session, which is always finished (the exporter only exports
// finished sessions), and the transport bar's live `TimeTarget` acts on the
// live store's push buffer, which a replay does not use.
//
// `DelayControl` and `AlignPanel` were mounted in `Shell` (under the header,
// on every route) until issue #57 fix round 5 moved them into the board's
// toolbar; issue #81 then deleted `DelayControl` and folded its behavior
// into the shared `TransportBar`, driven by `useLiveTimeTarget()` through
// the `TimeTarget` seam. Issue #67 routed `AlignPanel` (via `useAligner`)
// through the same seam instead of the live store directly, so it can also
// mount on a replay (`ReplayPage.tsx`) -- one `TimeTargetProvider` now wraps
// the whole `Board`, not just `TransportBar`, so both slots read the same
// target.
export function BoardPage() {
  const polls = usePolls();
  const status = useBoardSessionStatus();
  const { sessionKey, session } = useBoardSessionMeta();
  const target = useLiveTimeTarget();

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
