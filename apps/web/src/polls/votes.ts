// The viewer's own picks, per-viewer and never in the shared payload.
// Keyed by `poll_id` alone (`poll-vote-{poll_id}`): poll ids already embed
// the session key, so they never repeat across sessions, and keying by
// session too would silently lose a vote cast before the first SSE push
// (when the session key isn't known yet).
// See README: Polls.
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
