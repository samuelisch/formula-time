import { Link } from "react-router";

import { AlignPanel } from "../align/AlignPanel.tsx";
import { DelayControl } from "../align/DelayControl.tsx";
import { Board } from "../board/Board.tsx";
import { DriverPanel } from "../board/DriverPanel.tsx";
import { useBoardSessionMeta, useBoardSessionStatus } from "../board/useBoardState.ts";
import { date, stringField } from "../lib/format.ts";
import { PollModal } from "../polls/PollModal.tsx";
import { PollsButton } from "../polls/PollsButton.tsx";
import { usePolls } from "../polls/usePolls.ts";
import styles from "./BoardPage.module.css";

// The `/live` route: the pure `Board` (board/Board.tsx) plus everything that
// is live-only -- the finished/upcoming session banner, polls, and the
// alignment controls. `ReplayPage` mounts `Board` on its own, so none of
// this can leak onto a replay (issue #57 fix round 5): the banner would read
// the replay's own session, which is always finished (the exporter only
// exports finished sessions), and delay/alignment act on the live store's
// push buffer, which a replay does not use.
//
// `DelayControl` and `AlignPanel` were mounted in `Shell` (under the header,
// on every route) until this fix -- the placement `Shell`'s own comment
// always called temporary, pending the board's toolbar slot. They are
// live-only until alignment on a replay lands (#67).
export function BoardPage() {
  const polls = usePolls();
  const status = useBoardSessionStatus();
  const { sessionKey, session } = useBoardSessionMeta();

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
      <Board
        toolbar={
          <>
            <PollsButton />
            <DelayControl />
            <AlignPanel />
          </>
        }
        side={<DriverPanel />}
      />
      <PollModal polls={polls} />
    </div>
  );
}
