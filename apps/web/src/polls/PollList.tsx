// Sorted list of poll cards. Reads the viewer's session key once from the
// displayed push (issue #51 decision) and threads it down so each PollCard
// stays a pure function of its props.
import { useDisplayed } from "../live/selectors.ts";
import type { PollPublic } from "../live/types.ts";
import { PollCard } from "./PollCard.tsx";
import styles from "./PollList.module.css";
import { sortPolls } from "./sortPolls.ts";

export interface PollListProps {
  polls: PollPublic[];
}

export function PollList({ polls }: PollListProps) {
  const sessionKey = useDisplayed()?.session_key ?? null;
  const sorted = sortPolls(polls);

  if (sorted.length === 0) {
    return <p className={styles.empty}>No polls yet — they open once the grid is known.</p>;
  }

  return (
    <div className={styles.list}>
      {sorted.map((poll) => (
        <PollCard key={poll.poll_id} poll={poll} sessionKey={sessionKey} />
      ))}
    </div>
  );
}
