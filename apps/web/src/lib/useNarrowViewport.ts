// Whether the viewport is at or under --bp-narrow (index.css, 640px), for
// the few places that must know the breakpoint in JS rather than through a
// pure CSS media query alone: the align panel's default-collapsed state and
// the poll modal's bottom-sheet variant (apps/web/AGENTS.md responsive
// pass). Everything else collapses with plain CSS and needs no hook.
//
// jsdom has no window.matchMedia, so this reads defensively -- any
// existing test that never installs a stub (src/test/matchMedia.ts) simply
// gets `false`, the same as an environment with no matching media feature.
import { useEffect, useState } from "react";

const NARROW_QUERY = "(max-width: 640px)";

function readNarrow(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(readNarrow);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mediaQueryList = window.matchMedia(NARROW_QUERY);

    function onChange(event: MediaQueryListEvent): void {
      setNarrow(event.matches);
    }

    mediaQueryList.addEventListener("change", onChange);
    return () => mediaQueryList.removeEventListener("change", onChange);
  }, []);

  return narrow;
}
