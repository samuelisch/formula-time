import { create, type StoreApi, type UseBoundStore } from "zustand";

import { deriveAnchors, emptyAnchors, type Anchors } from "./anchors.ts";
import { append, emptyBuffer, select, type BufferedPush, type PushBuffer } from "./buffer.ts";
import { axisOf, type Connection, type LivePush } from "./types.ts";

export interface LiveStore {
  connection: Connection;
  catchingUp: boolean;
  /** True once at least one `status` SSE frame has landed -- distinguishes "still settling" (connected, nothing received yet) from "connected and confirmed no push is imminent" (issue #80/#94 fix round 2: PollsPage's default-race-selection needs this to know when it is safe to fall back to a historical race). */
  statusReceived: boolean;
  lastMessageAt: number | null;
  live: LivePush | null; // newest push, the live edge
  buffer: PushBuffer;
  delayMs: number; // 0 = live edge
  displayed: LivePush | null; // what the board renders
  bufferShort: boolean; // true when delay asks for older history than the buffer holds; displayed is then the oldest entry
  anchors: Anchors; // jump targets folded from pushes seen since this tab connected
  onOpen(): void;
  onError(): void;
  onStatus(status: { catching_up: boolean }): void;
  onState(raw: string, push: LivePush, now: number): void;
  setDelayMs(ms: number, now: number): void;
  tick(now: number): void;
}

export type LiveStoreApi = UseBoundStore<StoreApi<LiveStore>>;

interface Selection {
  displayed: LivePush | null;
  bufferShort: boolean;
}

/** Creates an isolated store instance with its own displayed-entry cache; the app uses the `useLiveStore` singleton below, tests create their own. */
export function createLiveStore(): LiveStoreApi {
  const parsedByEntry = new WeakMap<BufferedPush, LivePush>();
  const seenRestarts = new Set<string>();

  function parseCached(entry: BufferedPush): LivePush {
    const cached = parsedByEntry.get(entry);
    if (cached !== undefined) return cached;
    const parsed = JSON.parse(entry.raw) as LivePush;
    parsedByEntry.set(entry, parsed);
    return parsed;
  }

  function reselect(
    state: Pick<LiveStore, "live" | "buffer" | "delayMs" | "lastMessageAt">,
    now: number,
  ): Selection {
    if (state.delayMs === 0) {
      return { displayed: state.live, bufferShort: false };
    }
    if (state.live === null || state.buffer.entries.length === 0) {
      return { displayed: null, bufferShort: false };
    }

    const liveAxis = axisOf(state.live);
    const elapsed = state.lastMessageAt === null ? 0 : now - state.lastMessageAt;
    const target = liveAxis + elapsed - state.delayMs;

    const found = select(state.buffer, target);
    if (found !== null) {
      return { displayed: parseCached(found), bufferShort: false };
    }

    const oldest = state.buffer.entries[0];
    if (oldest === undefined) return { displayed: null, bufferShort: false };
    return { displayed: parseCached(oldest), bufferShort: true };
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

    onOpen: () => set({ connection: "open" }),
    onError: () => set({ connection: "reconnecting" }),
    onStatus: (status) => set({ catchingUp: status.catching_up, statusReceived: true }),

    onState: (raw, push, now) => {
      const buffer = append(get().buffer, { at: axisOf(push), raw });
      const anchors = deriveAnchors(get().anchors, push, seenRestarts);
      const next = { live: push, buffer, lastMessageAt: now, catchingUp: false, anchors };
      const { displayed, bufferShort } = reselect({ ...get(), ...next }, now);
      set({ ...next, displayed, bufferShort });
    },

    setDelayMs: (ms, now) => {
      const delayMs = Math.max(0, ms);
      const { displayed, bufferShort } = reselect({ ...get(), delayMs }, now);
      set({ delayMs, displayed, bufferShort });
    },

    tick: (now) => {
      const state = get();
      if (state.delayMs === 0) return;
      const { displayed, bufferShort } = reselect(state, now);
      set({ displayed, bufferShort });
    },
  }));
}

/** App-wide singleton. Tests use `createLiveStore()` for isolation. */
export const useLiveStore = createLiveStore();
