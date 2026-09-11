// Typed fake for the fan-out seam session-lifecycle.ts pushes through
// (session-lifecycle.ts's `Pusher`), so a test can record pushes without a
// real Fanout/socket.
import { vi } from "vitest";

import type { Pusher } from "../session-lifecycle.js";

export function fakePusher(size = 0): Pusher {
  return { push: vi.fn(async () => {}), size: () => size };
}
