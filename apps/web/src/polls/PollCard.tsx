// One poll: question, status pill, lock-lap meta, option rows as vote
// buttons, and a verdict line once resolved. Port of the POC's
// poll_render.js renderPollCards for the current status vocabulary (open,
// locked, resolved, void) and the app's own useVote/useMutation flow rather
// than a bare fetch.
//
// Collapsed inside a Collapsible: the summary is the status pill, question,
// and lock/vote-count line; the option rows, vote buttons,
// and verdict live in the expanded body. Open polls default open (they need
// a vote), every other status defaults collapsed. PollList and PollModal
// both render this unchanged -- the collapse behaviour comes for free.
import { Collapsible } from "../components/Collapsible.tsx";
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

/** The collapsed summary's lock/status word: the lock lap while open, else the status itself. */
function lockLine(poll: PollPublic): string {
  return poll.status === "open" ? `locks at lap ${poll.locks_at_lap}` : poll.status;
}

export interface PollCardProps {
  poll: PollPublic;
}

export function PollCard({ poll }: PollCardProps) {
  const vote = useVote();
  const myPick = myVote(poll.poll_id);
  const winners = poll.winning_option_ids ?? [];
  const maxVotes = Math.max(1, ...poll.options.map((option) => poll.tally[option.id] ?? 0));
  const canVote = poll.status === "open" && !vote.isPending;
  const statusClass = styles[`status-${poll.status}`] ?? "";

  function castVote(optionId: string): void {
    if (!canVote) return;
    vote.mutate({ pollId: poll.poll_id, optionId });
  }

  const summary = (
    <span className={styles.header}>
      <span className={`${styles.statusPill} ${statusClass}`}>{STATUS_LABEL[poll.status]}</span>
      <span className={styles.question}>{poll.question}</span>
      <span className={styles.meta}>
        {lockLine(poll)} · {poll.total_votes} vote{poll.total_votes === 1 ? "" : "s"}
      </span>
    </span>
  );

  return (
    <article className={styles.card} data-status={poll.status}>
      <Collapsible summary={summary} defaultOpen={poll.status === "open"}>
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
      </Collapsible>
    </article>
  );
}
