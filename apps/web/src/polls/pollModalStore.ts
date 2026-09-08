// Tiny UI-only store for the poll modal's open/closed state and the last
// poll signature it has seen. Shared between PollsButton (manual open) and
// PollModal (auto-pop + close), which are mounted as independent siblings
// in BoardPage. Deliberately separate from the live store
// (apps/web/src/live/store.ts) -- this holds no race state.
//
// The signature lives here rather than in a PollModal-local ref
// (fix-round-1 bug): BoardPage and PollsPage are sibling routes, so
// navigating away and back remounts PollModal. A per-instance ref resets to
// "" on that remount, so the auto-pop effect would treat an unchanged,
// already-dismissed poll set as a fresh transition and re-pop it. Keeping
// the signature in this singleton (which survives the remount, same as
// `isOpen`) makes "never re-pops for an unchanged set" hold across
// navigation, not just across rerenders of one instance.
import { create } from "zustand";

export interface PollModalUiState {
  isOpen: boolean;
  /** The `poll_id:status` signature last observed, scoped to `lastSessionKey`. */
  lastSignature: string;
  /** The session the signature above belongs to; a new session (race) starts the signature fresh. */
  lastSessionKey: string | null;
  open(): void;
  close(): void;
  setSignature(signature: string, sessionKey: string | null): void;
}

export function createPollModalUiStore() {
  return create<PollModalUiState>((set) => ({
    isOpen: false,
    lastSignature: "",
    lastSessionKey: null,
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
    setSignature: (signature, sessionKey) => set({ lastSignature: signature, lastSessionKey: sessionKey }),
  }));
}

export const usePollModalUiStore = createPollModalUiStore();
