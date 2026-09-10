// The race-start seek: shared by the transport bar's "Race start" button and
// the replay page's start notice, so there is exactly one place that knows
// how to jump to lights-out and pause. Returns false, with no side effect,
// when the target has never seen a lights-out anchor.
import type { TimeTarget } from "./TimeTarget.ts";

export function jumpToRaceStart(target: TimeTarget): boolean {
  const lightsOut = target.anchors().lights_out;
  if (lightsOut === null) return false;
  target.seekTo(Date.parse(lightsOut));
  target.playback()?.pause();
  return true;
}
