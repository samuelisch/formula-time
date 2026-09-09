// Displayed polls: polls render from the displayed push, never the live
// edge, so a delayed viewer sees tallies and statuses
// as of their own moment -- the spoiler rule without a gating transform.
//
// The push comes through the board seam (`useBoardPush()`,
// apps/web/src/board/useBoardState.ts), not `useDisplayed()` directly, for
// the same reason every other board hook does: `BoardPage` also renders
// under a replay's `BoardSourceProvider`, and `Shell` keeps the live SSE
// connection open on every route. A replay's synthesized push carries
// `polls: []` (polls are live-only by product stance), so under the
// provider this returns nothing -- no poll button count, no auto-pop for an
// unrelated live result mid-replay. On the live route no provider is
// mounted and `useBoardPush()` falls back to `useDisplayed()`, so live
// behaviour is unchanged. No fallback to a live selector here.
import { useBoardPush } from "../board/useBoardState.ts";
import type { PollPublic } from "../live/types.ts";

export function usePolls(): PollPublic[] {
  return useBoardPush()?.polls ?? [];
}
