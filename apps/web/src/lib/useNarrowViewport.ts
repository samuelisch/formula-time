// Whether the viewport is at or under --bp-narrow (index.css, 640px), for
// the few places that must know the breakpoint in JS rather than through a
// pure CSS media query alone. jsdom has no window.matchMedia, so this
// reads defensively -- an environment or test with no stub simply gets
// `false`.
// See README: Narrow-viewport detection.
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
