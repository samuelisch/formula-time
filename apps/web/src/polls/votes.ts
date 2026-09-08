// The viewer's own picks, per-viewer and never in the shared payload
// (issue #51 decision): localStorage key `poll-vote-{session_key}-{poll_id}`,
// the POC's poll_render.js / app.js pollStorageKey convention.
const UNKNOWN_SESSION = "unknown";

export function voteKey(sessionKey: string | null, pollId: string): string {
  return `poll-vote-${sessionKey ?? UNKNOWN_SESSION}-${pollId}`;
}

/** The viewer's remembered pick for one poll, or null if they haven't voted (or storage is unavailable). */
export function myVote(sessionKey: string | null, pollId: string): string | null {
  try {
    return localStorage.getItem(voteKey(sessionKey, pollId));
  } catch {
    return null; // cosmetic only -- a blocked storage never breaks voting
  }
}

export function rememberVote(sessionKey: string | null, pollId: string, optionId: string): void {
  try {
    localStorage.setItem(voteKey(sessionKey, pollId), optionId);
  } catch {
    /* cosmetic only */
  }
}
