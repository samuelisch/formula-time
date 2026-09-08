import { describe, expect, test, vi } from "vitest";

import { createSessionLifecycle, type Pusher } from "./session-lifecycle.js";

function fakePusher(): Pusher {
  return { push: vi.fn(async () => {}), size: () => 0 };
}

describe("createSessionLifecycle", () => {
  test("/health shape before any session is found: session_key null, cursor \"0\", caught_up false", async () => {
    const pickSession = vi.fn(async () => null);
    const lifecycle = createSessionLifecycle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      source: {} as any,
      pusher: fakePusher(),
      pickSession,
      publicPolls: () => [],
      log: () => {},
    });

    await lifecycle.check();

    expect(lifecycle.health()).toEqual({
      ok: true,
      session_key: null,
      cursor: "0",
      caught_up: false,
      viewers: 0,
    });
    expect(pickSession).toHaveBeenCalledTimes(1);
  });

  test("reports the pusher's current viewer count even with no session", () => {
    const pusher: Pusher = { push: vi.fn(async () => {}), size: () => 3 };
    const lifecycle = createSessionLifecycle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      source: {} as any,
      pusher,
      pickSession: vi.fn(async () => null),
      publicPolls: () => [],
      log: () => {},
    });

    expect(lifecycle.health().viewers).toBe(3);
  });

  test("stop() is safe to call with no projector running", () => {
    const lifecycle = createSessionLifecycle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      source: {} as any,
      pusher: fakePusher(),
      pickSession: vi.fn(async () => null),
      publicPolls: () => [],
      log: () => {},
    });

    expect(() => lifecycle.stop()).not.toThrow();
  });

  test("no session found logs the warning only once across repeated checks", async () => {
    const log = vi.fn();
    const lifecycle = createSessionLifecycle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      source: {} as any,
      pusher: fakePusher(),
      pickSession: vi.fn(async () => null),
      publicPolls: () => [],
      log,
    });

    await lifecycle.check();
    await lifecycle.check();
    await lifecycle.check();

    expect(log).toHaveBeenCalledTimes(1);
  });
});
