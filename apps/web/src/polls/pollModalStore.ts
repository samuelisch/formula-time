// Tiny UI-only store for the poll modal's open/closed state and the last
// poll signature it has seen. Shared between PollsButton (manual open)
// and PollModal (auto-pop + close), mounted as independent siblings in
// BoardPage. Deliberately separate from the live store -- this holds no
// race state.
// See README: Polls.
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

function createPollModalUiStore() {
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
