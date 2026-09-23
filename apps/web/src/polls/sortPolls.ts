// Render order for PollList: open first (needs a vote), then locked
// (awaiting result), then resolved, then void.
import type { PollLifecycleStatus, PollPublic } from "../live/types.ts";

const STATUS_ORDER: Record<PollLifecycleStatus, number> = {
  open: 0,
  locked: 1,
  resolved: 2,
  void: 3,
};

/** Stable sort: polls sharing a status keep their incoming relative order. */
export function sortPolls(polls: PollPublic[]): PollPublic[] {
  return [...polls].sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status]);
}
