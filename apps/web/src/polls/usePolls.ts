// Displayed polls: polls render from the displayed push, never the live
// edge, so a delayed viewer sees tallies and statuses as of their own
// moment -- the spoiler rule without a gating transform. Reads through
// the board seam (`useBoardPush()`), not `useDisplayed()` directly, so a
// replay's push (`polls: []`) returns nothing instead of a live result.
// See README: Polls.
import { useBoardPush } from "../board/useBoardState.ts";
import type { PollPublic } from "../live/types.ts";

export function usePolls(): PollPublic[] {
  return useBoardPush()?.polls ?? [];
}
