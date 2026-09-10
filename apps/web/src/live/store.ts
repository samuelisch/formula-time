import type { RaceEvent } from "@formula-time/domain";
import { create, type StoreApi, type UseBoundStore } from "zustand";

import { foldAt, type Timeline } from "../replay/timeline.ts";
import { deriveAnchors, emptyAnchors, type Anchors } from "./anchors.ts";
import { append, emptyBuffer, select, type BufferedPush, type PushBuffer } from "./buffer.ts";
import { axisOf, type Connection, type LivePush, type RewindMode } from "./types.ts";

/**
 * Whether `timeline` is the live session's own log -- `createTimeline`
 * always normalises `session.session_key` to a string (see
 * `replay/timeline.ts`), so this is a plain string comparison against the
 * live push's own `session_key`. A timeline for a different session (e.g.
 * a stale one left over from before a session change finished unmounting)
 * must never be folded from. Exported so `live/selectors.ts`'s
 * `useTimeline()` can apply the identical guard: `useLiveTimeTarget`'s
 * `anchors()`/`range()` must never see a mismatched timeline either.
 */
export function timelineMatchesSession(timeline: Timeline, liveSessionKey: string): boolean {
  const key = timeline.session["session_key"];
  return typeof key === "string" && key === liveSessionKey;
}

/**
 * The live edge on the source axis: the newest push's own axis time, plus
 * however much wall-clock time has elapsed since it arrived. Null before
 * the first push, since there is nothing to measure from yet. Exported so
 * a caller that only needs this value for display (a render, not an
 * action) -- `useLiveTimeTarget`'s `range()` -- can compute the identical
 * formula `reselect` uses internally, so the two can never disagree.
 */
export function headAxisOf(state: Pick<LiveStore, "live" | "lastMessageAt">, now: number): number | null {
  if (state.live === null) return null;
  return axisOf(state.live) + (state.lastMessageAt === null ? 0 : now - state.lastMessageAt);
}

export interface LiveStore {
  connection: Connection;
  catchingUp: boolean;
  /** True once at least one `status` SSE frame has landed -- distinguishes "still settling" (connected, nothing received yet) from "connected and confirmed no push is imminent". PollsPage's default-race-selection needs this to know when it is safe to fall back to a historical race. */
  statusReceived: boolean;
  lastMessageAt: number | null;
  live: LivePush | null; // newest push, the live edge
  buffer: PushBuffer;
  delayMs: number; // 0 = live edge
  displayed: LivePush | null; // what the board renders
  bufferShort: boolean; // true when delay asks for older history than the buffer holds; displayed is then the oldest entry
  anchors: Anchors; // jump targets folded from pushes seen since this tab connected
  /** The browser-side full-race timeline for the live session, set by the page that loads it (`LiveTimelineLoader`); null when not loaded. */
  timeline: Timeline | null;
  /** How `displayed` was chosen: "edge" (delay 0), "buffer" (from the push ring buffer, including the `bufferShort` fallback), or "timeline" (synthesised from `foldAt`). */
  mode: RewindMode;
  onOpen(): void;
  onError(): void;
  onStatus(status: { catching_up: boolean }): void;
  onState(raw: string, push: LivePush, now: number): void;
  setDelayMs(ms: number, now: number): void;
  /** Sets the delay so the viewer sees source time `atMs`, reading the current head at call time -- never a snapshot from an earlier render -- so a push arriving between a render and this call cannot throw the result off. No-op before the first push (nothing to seek relative to). */
  seekToAxis(atMs: number, now: number): void;
  /** Moves the delay by `deltaMs` (forward = less delay), reading the current delay at call time -- never a snapshot from an earlier render -- so repeated calls compound correctly even when none of them triggers a render in between. */
  nudgeDelay(deltaMs: number, now: number): void;
  setTimeline(timeline: Timeline | null, now: number): void;
  tick(now: number): void;
}

export type LiveStoreApi = UseBoundStore<StoreApi<LiveStore>>;

interface Selection {
  displayed: LivePush | null;
  bufferShort: boolean;
  mode: RewindMode;
}

/** Creates an isolated store instance with its own displayed-entry cache; the app uses the `useLiveStore` singleton below, tests create their own. */
export function createLiveStore(): LiveStoreApi {
  const parsedByEntry = new WeakMap<BufferedPush, LivePush>();
  const seenRestarts = new Set<string>();

  // One-entry cache for the timeline-mode synthesised push: `foldAt` clones
  // on every call, so without this, `displayed` would get a new reference
  // on every 250ms tick even when the fold did not cross an event
  // boundary -- breaking the referential-stability guarantee the buffer
  // path gets from `parsedByEntry` above. A cached entry is reused only
  // when all three of its keys still match the current call: `events`
  // (the mutable array `appendEvents` pushes onto in place -- unchanged by
  // `useSessionTimeline` publishing a new shallow *copy* of the `Timeline`
  // per page/push, so that alone must not invalidate the cache; a
  // restarted backfill hands over a genuinely new array), `sequence`
  // (`RaceStateReducer` increments it once per applied, non-duplicate
  // event, so two folds that stop at the same event boundary agree on it
  // regardless of how far `now` advanced between them), and `live` itself
  // (a real push arriving mid-interval still changes the envelope --
  // `seq`/`sent_at`/`session_key`/`total_laps` -- even when its fold lands
  // on the same `sequence` as the previous one, so the cached push must
  // not be reused across two different `live` values; comparing `live` by
  // reference is enough, since every push is a fresh, immutable object).
  let lastTimelineDisplayed: { events: RaceEvent[]; sequence: number; live: LivePush; push: LivePush } | null = null;

  function parseCached(entry: BufferedPush): LivePush {
    const cached = parsedByEntry.get(entry);
    if (cached !== undefined) return cached;
    const parsed = JSON.parse(entry.raw) as LivePush;
    parsedByEntry.set(entry, parsed);
    return parsed;
  }

  function timelineDisplayed(timeline: Timeline, atMs: number, live: LivePush): LivePush {
    const state = foldAt(timeline, atMs);
    if (
      lastTimelineDisplayed !== null &&
      lastTimelineDisplayed.events === timeline.events &&
      lastTimelineDisplayed.sequence === state.sequence &&
      lastTimelineDisplayed.live === live
    ) {
      return lastTimelineDisplayed.push;
    }
    const push: LivePush = {
      type: "state",
      seq: live.seq,
      sent_at: live.sent_at,
      session_key: live.session_key,
      total_laps: live.total_laps,
      state,
      polls: [],
    };
    lastTimelineDisplayed = { events: timeline.events, sequence: state.sequence, live, push };
    return push;
  }

  function reselect(
    state: Pick<LiveStore, "live" | "buffer" | "delayMs" | "lastMessageAt" | "timeline">,
    now: number,
  ): Selection {
    if (state.delayMs === 0) {
      return { displayed: state.live, bufferShort: false, mode: "edge" };
    }
    if (state.live === null) {
      return { displayed: null, bufferShort: false, mode: "edge" };
    }

    const target = headAxisOf(state, now)! - state.delayMs; // state.live checked non-null above

    const found = select(state.buffer, target);
    if (found !== null) {
      return { displayed: parseCached(found), bufferShort: false, mode: "buffer" };
    }

    if (
      state.timeline !== null &&
      state.timeline.firstSourceMs !== null &&
      timelineMatchesSession(state.timeline, state.live.session_key)
    ) {
      const atMs = Math.max(target, state.timeline.firstSourceMs);
      return { displayed: timelineDisplayed(state.timeline, atMs, state.live), bufferShort: false, mode: "timeline" };
    }

    const oldest = state.buffer.entries[0];
    if (oldest === undefined) return { displayed: null, bufferShort: false, mode: "buffer" };
    return { displayed: parseCached(oldest), bufferShort: true, mode: "buffer" };
  }

  return create<LiveStore>()((set, get) => ({
    connection: "connecting",
    catchingUp: false,
    statusReceived: false,
    lastMessageAt: null,
    live: null,
    buffer: emptyBuffer(),
    delayMs: 0,
    displayed: null,
    bufferShort: false,
    anchors: emptyAnchors(),
    timeline: null,
    mode: "edge",

    onOpen: () => set({ connection: "open" }),
    onError: () => set({ connection: "reconnecting" }),
    onStatus: (status) => set({ catchingUp: status.catching_up, statusReceived: true }),

    onState: (raw, push, now) => {
      const buffer = append(get().buffer, { at: axisOf(push), raw });
      const anchors = deriveAnchors(get().anchors, push, seenRestarts);
      const next = { live: push, buffer, lastMessageAt: now, catchingUp: false, anchors };
      const { displayed, bufferShort, mode } = reselect({ ...get(), ...next }, now);
      set({ ...next, displayed, bufferShort, mode });
    },

    setDelayMs: (ms, now) => {
      const delayMs = Math.max(0, ms);
      const { displayed, bufferShort, mode } = reselect({ ...get(), delayMs }, now);
      set({ delayMs, displayed, bufferShort, mode });
    },

    seekToAxis: (atMs, now) => {
      const head = headAxisOf(get(), now);
      if (head === null) return;
      get().setDelayMs(Math.max(0, head - atMs), now);
    },

    nudgeDelay: (deltaMs, now) => {
      get().setDelayMs(Math.max(0, get().delayMs - deltaMs), now);
    },

    setTimeline: (timeline, now) => {
      const { displayed, bufferShort, mode } = reselect({ ...get(), timeline }, now);
      set({ timeline, displayed, bufferShort, mode });
    },

    tick: (now) => {
      const state = get();
      if (state.delayMs === 0) return;
      const { displayed, bufferShort, mode } = reselect(state, now);
      set({ displayed, bufferShort, mode });
    },
  }));
}

/** App-wide singleton. Tests use `createLiveStore()` for isolation. */
export const useLiveStore = createLiveStore();
