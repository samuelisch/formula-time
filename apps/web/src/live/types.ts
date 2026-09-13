import type { StatePush } from "@formula-time/domain";
export type { PollLifecycleStatus, PollOptionPublic, PollPublic } from "@formula-time/domain";
// `StatePush` (packages/domain/src/wire.ts) is the api's full-state push,
// verbatim; kept under this app's own name since it ripples through most
// of `live/` and `board/` -- see there for what `events` and `rebuilt` mean.
export type { StatePush as LivePush, DeltaPush } from "@formula-time/domain";

export type Connection = "connecting" | "open" | "reconnecting";

/** How `displayed` was chosen: the live edge, the push ring buffer (including the oldest-entry fallback), or synthesised from the browser-side timeline past the buffer. */
export type RewindMode = "edge" | "buffer" | "timeline";

/** The POC's anchor axis for delay: source time when available, else the send time. */
export function axisOf(push: StatePush): number {
  const sourceMillis = push.state.latest_source_time === null ? NaN : Date.parse(push.state.latest_source_time);
  return Number.isFinite(sourceMillis) ? sourceMillis : push.sent_at;
}
