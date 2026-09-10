// A page can override the shell header's session line while it is mounted
// (e.g. a replay describing its own folded session instead of the live
// stream) without opening a second EventSource or drilling props through
// the router. `Shell` reads `override?.line` ahead of its own live-derived
// line; the owning page clears the override on unmount.
import { create } from "zustand";

export interface HeaderOverride {
  line: string;
}

export interface HeaderStore {
  override: HeaderOverride | null;
  setOverride(line: string | null): void;
}

export const useHeaderStore = create<HeaderStore>((set) => ({
  override: null,
  setOverride: (line) => set({ override: line === null ? null : { line } }),
}));
