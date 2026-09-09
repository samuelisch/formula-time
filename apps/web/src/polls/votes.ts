// The viewer's own picks, per-viewer and never in the shared payload.
// Keyed by `poll_id` alone (`poll-vote-{poll_id}`) rather than
// `poll-vote-{session_key}-{poll_id}`: poll ids already embed the session
// key (`${sessionKey}:winner` / `${sessionKey}:podium`,
// apps/api/src/polls/poll-module.ts), so they never repeat across sessions
// and the session segment was redundant. It was also actively wrong: a vote
// cast during the /polls page's initial-fill window (before the first SSE
// push, when the session key is not yet known) wrote under
// `poll-vote-unknown-{poll_id}`; once the push landed and the real session
// key was known, `myVote` looked under a different key and silently lost
// the pick. Keying by poll_id alone makes that race impossible.
function voteKey(pollId: string): string {
  return `poll-vote-${pollId}`;
}

/** The viewer's remembered pick for one poll, or null if they haven't voted (or storage is unavailable). */
export function myVote(pollId: string): string | null {
  try {
    return localStorage.getItem(voteKey(pollId));
  } catch {
    return null; // cosmetic only -- a blocked storage never breaks voting
  }
}

export function rememberVote(pollId: string, optionId: string): void {
  try {
    localStorage.setItem(voteKey(pollId), optionId);
  } catch {
    /* cosmetic only */
  }
}
