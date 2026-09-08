// Displayed polls (issue #51 decision): polls render from the displayed
// push (`useDisplayed().polls`), never the live edge, so a delayed viewer
// sees tallies and statuses as of their own moment -- the spoiler rule
// without a gating transform. No fallback to a live selector here.
import { useDisplayed } from "../live/selectors.ts";
import type { PollPublic } from "../live/types.ts";

export function usePolls(): PollPublic[] {
  return useDisplayed()?.polls ?? [];
}
