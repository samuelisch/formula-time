// Pure push ring buffer (no React). Stores each push already parsed, by
// reference -- nothing in this app writes through a stored push; every
// reader either reads it or builds a new object from it. The entry count /
// age cap below is the memory bound.
import type { LivePush } from "./types.ts";

export interface BufferedPush {
  at: number;
  push: LivePush;
}

/** Ascending by `at`. */
export interface PushBuffer {
  entries: readonly BufferedPush[];
}

export const BUFFER_LIMITS = { maxEntries: 600, maxAgeMs: 180_000 } as const;

export function emptyBuffer(): PushBuffer {
  return { entries: [] };
}

/**
 * Appends `entry`, clamping its `at` up to the current newest so the axis
 * stays monotonic, then evicts by age from the newest entry, then by count.
 */
export function append(
  buffer: PushBuffer,
  entry: BufferedPush,
  limits: { maxEntries: number; maxAgeMs: number } = BUFFER_LIMITS,
): PushBuffer {
  const newest = buffer.entries[buffer.entries.length - 1];
  const at = newest !== undefined && entry.at < newest.at ? newest.at : entry.at;
  let entries = [...buffer.entries, { at, push: entry.push }];

  const cutoff = at - limits.maxAgeMs;
  entries = entries.filter((e) => e.at >= cutoff);

  if (entries.length > limits.maxEntries) {
    entries = entries.slice(entries.length - limits.maxEntries);
  }

  return { entries };
}

/** Newest entry with `at <= targetAt`, via binary search. Null when the buffer is empty or every entry is newer than targetAt. */
export function select(buffer: PushBuffer, targetAt: number): BufferedPush | null {
  const entries = buffer.entries;
  if (entries.length === 0) return null;

  let lo = 0;
  let hi = entries.length - 1;
  let result: BufferedPush | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = entries[mid];
    if (candidate === undefined) break;
    if (candidate.at <= targetAt) {
      result = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/** newest.at - oldest.at, 0 when fewer than two entries. */
export function span(buffer: PushBuffer): number {
  const entries = buffer.entries;
  if (entries.length < 2) return 0;
  const oldest = entries[0];
  const newest = entries[entries.length - 1];
  if (oldest === undefined || newest === undefined) return 0;
  return newest.at - oldest.at;
}
