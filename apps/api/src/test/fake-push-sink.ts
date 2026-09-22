// Typed fake for the fan-out seam projector/serve-session.ts pushes through
// (projector/serve-session.ts's `PushSink`), so a test can record pushes without a
// real Fanout/socket.
import { vi } from "vitest";

import type { PushSink } from "../projector/serve-session.js";

export function fakePushSink(size = 0): PushSink {
  return { push: vi.fn(async () => {}), size: () => size };
}
