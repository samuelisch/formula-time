// One poll: question, status pill, lock-lap meta, option rows as vote
// buttons, and a verdict line once resolved. Port of the POC's
// poll_render.js renderPollCards for the current status vocabulary (open,
// locked, resolved, void) and the app's own useVote/useMutation flow rather
// than a bare fetch.
import type { PollLifecycleStatus, PollPublic } from "../live/types.ts";
import styles from "./PollCard.module.css";
import { useVote } from "./useVote.ts";
import { myVote } from "./votes.ts";

const STATUS_LABEL: Record<PollLifecycleStatus, string> = {
  open: "OPEN",
  locked: "LOCKED · awaiting result",
  resolved: "RESOLVED",
  void: "VOID",
};

export interface PollCardProps {
  poll: PollPublic;
  /** From `useDisplayed()?.session_key` -- passed down so this card stays a pure function of its props. */
  sessionKey: string | null;
}

export function PollCard({ poll, sessionKey }: PollCardProps) {
  const vote = useVote(sessionKey);
  const myPick = myVote(sessionKey, poll.poll_id);
  const winners = poll.winning_option_ids ?? [];
  const maxVotes = Math.max(1, ...poll.options.map((option) => poll.tally[option.id] ?? 0));
  const canVote = poll.status === "open" && !vote.isPending;
  const statusClass = styles[`status-${poll.status}`] ?? "";

  function castVote(optionId: string): void {
    if (!canVote) return;
    vote.mutate({ pollId: poll.poll_id, optionId });
  }

  return (
    <article className={styles.card} data-status={poll.status}>
      <header className={styles.header}>
        <span className={`${styles.statusPill} ${statusClass}`}>{STATUS_LABEL[poll.status]}</span>
        <h3 className={styles.question}>{poll.question}</h3>
        <span className={styles.meta}>
          locks at lap {poll.locks_at_lap} · {poll.total_votes} vote{poll.total_votes === 1 ? "" : "s"}
        </span>
      </header>

      {poll.status === "resolved" && myPick !== null ? (
        <p className={winners.includes(myPick) ? styles.verdictCorrect : styles.verdictWrong}>
          {winners.includes(myPick) ? "✓ You called it" : "✗ Not this time"}
        </p>
      ) : null}

      {vote.isError ? <p className={styles.error}>{vote.error.message}</p> : null}

      <div className={styles.rows}>
        {poll.options.map((option) => {
          const votes = poll.tally[option.id] ?? 0;
          const pct = poll.total_votes > 0 ? Math.round((votes / poll.total_votes) * 100) : 0;
          const isMine = myPick === option.id;
          const won = winners.includes(option.id);
          const rowClass = [styles.row, isMine ? styles.mine : "", won ? styles.winner : ""].filter(Boolean).join(" ");

          return (
            <button
              key={option.id}
              type="button"
              className={rowClass}
              disabled={!canVote}
              onClick={() => castVote(option.id)}
            >
              <span className={styles.fill} style={{ width: `${Math.round((votes / maxVotes) * 100)}%` }} />
              <span className={styles.label}>
                {won ? "🏆 " : ""}
                {option.label}
                {isMine ? " · your pick" : ""}
              </span>
              <span className={styles.pct}>{pct}%</span>
              <span className={styles.votes}>
                {votes} vote{votes === 1 ? "" : "s"}
              </span>
            </button>
          );
        })}
      </div>
    </article>
  );
}
