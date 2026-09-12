// Rate-limiting/retry wrapper for any `Fetcher` that talks to the live
// OpenF1 API over the network. Shared by `fetch-race.ts` (its own historical
// pull) and `load-recording.ts` (its meetings-lookup network fallback) —
// one implementation, so both obey the same spacing/retry budget rather
// than each hand-rolling it.

import type { Fetcher } from "./types.js";

// Respect the rate limit: at most 3 requests per second and 30 per minute
// (a 2.1 s spacing satisfies both) — 2.1s * 30 = 63s per 30 requests, i.e.
// well under the per-minute cap too, and comfortably under 3/s.
export const FETCH_SPACING_MS = 2100;
// Retry a 429 or 5xx after 20 s, at most 3 times.
export const RETRY_DELAY_MS = 20_000;
export const MAX_RETRIES = 3;

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enforces a minimum spacing between successive calls through `fetcher`:
 * at most 3 requests per second and 30 per minute. `now`/`sleep`
 * are injectable so a test can drive a fake clock without a real
 * wait — `sleep` advancing a shared fake `now` is what makes "8 requests
 * take >= 14.7s of fake time" (7 gaps of 2.1s) provable without the test
 * actually taking 14.7 real seconds.
 */
export function withSpacing(
  fetcher: Fetcher,
  spacingMs: number,
  opts: { now?: () => number; sleep?: Sleep } = {},
): Fetcher {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  let lastCallAt: number | null = null;
  return async (url: string): Promise<unknown> => {
    if (lastCallAt !== null) {
      const elapsed = now() - lastCallAt;
      if (elapsed < spacingMs) await sleep(spacingMs - elapsed);
    }
    lastCallAt = now();
    return fetcher(url);
  };
}

// `createOpenF1Fetcher` (auth.ts) throws `Error("OpenF1 <status> for
// <url>")` for any non-ok, non-404 response — the same signal `withRetry`
// below reads to decide whether a failure is retryable, so the two stay
// consistent without `withRetry` needing its own HTTP layer.
const STATUS_PATTERN = /OpenF1 (\d+) for/;

function statusFromError(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = STATUS_PATTERN.exec(error.message);
  return match ? Number(match[1]) : null;
}

export interface RetryOptions {
  retryDelayMs?: number;
  maxRetries?: number;
  sleep?: Sleep;
}

/**
 * Retries a 429 or 5xx after `retryDelayMs` (default 20s), up to
 * `maxRetries` times (default 3) — "a 404 is 'no rows', not an error"
 * (handled already, by `createOpenF1Fetcher` returning `[]`, never
 * throwing, so it never reaches here).
 */
export function withRetry(fetcher: Fetcher, opts: RetryOptions = {}): Fetcher {
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  return async (url: string): Promise<unknown> => {
    let attempt = 0;
    for (;;) {
      try {
        return await fetcher(url);
      } catch (error) {
        const status = statusFromError(error);
        const retryable = status === 429 || (status !== null && status >= 500 && status < 600);
        attempt += 1;
        if (!retryable || attempt > maxRetries) throw error;
        await sleep(retryDelayMs);
      }
    }
  };
}
