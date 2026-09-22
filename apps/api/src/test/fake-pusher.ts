// Typed fake for the fan-out seam projector/serve-session.ts pushes through
// (projector/serve-session.ts's `Pusher`), so a test can record pushes without a
// real Fanout/socket.
import { vi } from "vitest";

import type { Pusher } from "../projector/serve-session.js";

export function fakePusher(size = 0): Pusher {
  return { push: vi.fn(async () => {}), size: () => size };
}
