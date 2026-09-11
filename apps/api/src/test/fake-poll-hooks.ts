// Typed fake for the poll module's lifecycle hooks (session-lifecycle.ts's
// PollHooks). `onState()` resolves one microtask later by default -- never
// synchronously -- per the AGENTS.md test rule: a fake that resolves
// synchronously cannot test ordering. A test that needs to hold more than
// one fold in flight at once (to prove a later tick's onState() being
// requested before an earlier one resolves doesn't leak into the earlier
// tick's push) constructs it with `manualOnState: true` and drives
// resolution itself with `resolveNext()`, FIFO, one call per pending fold.
import { vi } from "vitest";

import type { PollHooks } from "../session-lifecycle.js";

export interface FakePollHooks extends PollHooks {
  calls: string[];
  /** Resolve the oldest still-pending onState() call. Only meaningful when
   * constructed with `manualOnState: true`. */
  resolveNext(): void;
}

export function fakePollHooks(
  options: { calls?: string[]; manualOnState?: boolean } = {},
): FakePollHooks {
  const calls = options.calls ?? [];
  const pending: Array<() => void> = [];

  return {
    calls,
    start: vi.fn(async () => {
      calls.push("start");
    }),
    onState: vi.fn(async () => {
      calls.push("onState");
      if (options.manualOnState === true) {
        await new Promise<void>((resolve) => pending.push(resolve));
      } else {
        await Promise.resolve();
      }
    }),
    onSessionFinished: vi.fn(async () => {
      calls.push("onSessionFinished");
    }),
    publicPolls: vi.fn(() => [{ poll_id: "fake" }]),
    resolveNext(): void {
      const next = pending.shift();
      if (next !== undefined) next();
    },
  };
}
