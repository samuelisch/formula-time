// jsdom has no window.matchMedia. Installs a stub that answers `matches:
// true` only for the narrow-viewport query (mirrors --bp-narrow, 640px, in
// index.css), so a component or test that reads it sees a phone-width
// result. Call restore() (e.g. in afterEach) to put the original back.
type ChangeListener = (event: MediaQueryListEvent) => void;

const NARROW_QUERY = "(max-width: 640px)";

export function installNarrowMatchMedia(matches = true): { restore: () => void } {
  const original = window.matchMedia;

  window.matchMedia = ((query: string) => {
    const listeners = new Set<ChangeListener>();
    const mediaQueryList = {
      matches: query === NARROW_QUERY ? matches : false,
      media: query,
      onchange: null,
      addEventListener: (_type: "change", listener: ChangeListener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: "change", listener: ChangeListener) => {
        listeners.delete(listener);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
    return mediaQueryList as unknown as MediaQueryList;
  }) as typeof window.matchMedia;

  return {
    restore: () => {
      window.matchMedia = original;
    },
  };
}
