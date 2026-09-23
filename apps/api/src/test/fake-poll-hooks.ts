// Typed fake for the poll module's lifecycle hooks (serve-session.ts's
// PollHooks). `onState()` resolves one microtask later by default, never
// synchronously (a synchronous fake cannot test ordering). A test that
// needs more than one fold in flight constructs it with
// `manualOnState: true` and drives resolution itself with
// `resolveNext()`, FIFO, one call per pending fold.
import { vi } from "vitest";

import type { PollHooks } from "../projector/serve-session.js";

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
    updateSession: vi.fn(() => {
      calls.push("updateSession");
    }),
    resolveNext(): void {
      const next = pending.shift();
      if (next !== undefined) next();
    },
  };
}
