// Folds a delta push (ADR-0013) against the previously held full push into
// the next full push. Pure -- no store access, no fetch: `useLiveStream.ts`
// owns the gap-recovery fetch this function's `null` result signals for.
import { applyPatch } from "@formula-time/domain";

import type { DeltaPush, LivePush } from "./types.ts";

/**
 * `null` before any push is held, or when `frame.base_seq` does not equal
 * `held.seq` -- a gap the caller resolves with `GET /api/live/snapshot`,
 * never by applying the patch against a state it does not describe.
 */
export function applyDelta(held: LivePush | null, frame: DeltaPush): LivePush | null {
  if (held === null || frame.base_seq !== held.seq) {
    return null;
  }
  const next: LivePush = {
    type: "state",
    seq: frame.seq,
    sent_at: frame.sent_at,
    session_key: frame.session_key,
    total_laps: held.total_laps,
    state: applyPatch(held.state, frame.patch),
    polls: frame.polls,
  };
  // Assigned only when present -- `exactOptionalPropertyTypes` treats an
  // explicit `undefined` as distinct from the key being absent.
  if (frame.events !== undefined) next.events = frame.events;
  if (frame.rebuilt !== undefined) next.rebuilt = frame.rebuilt;
  return next;
}
