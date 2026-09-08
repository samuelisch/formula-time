// Tiny UI-only store for the poll modal's open/closed state: shared between
// PollsButton (manual open) and PollModal (auto-pop + close), which are
// mounted as independent siblings in BoardPage. Deliberately separate from
// the live store (apps/web/src/live/store.ts) -- this holds no race state.
import { create } from "zustand";

export interface PollModalUiState {
  isOpen: boolean;
  open(): void;
  close(): void;
}

export function createPollModalUiStore() {
  return create<PollModalUiState>((set) => ({
    isOpen: false,
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
  }));
}

export const usePollModalUiStore = createPollModalUiStore();
