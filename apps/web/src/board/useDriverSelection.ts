// The driver panel's selection lives in the URL (`?driver=<number>`), not in
// component state, so it survives reload and deep links on both `/live` and
// `/races/:session_key` (issue #90). `DriverRow` and `DriverPanel` share this
// hook rather than each parsing `useSearchParams()` themselves.
import { useCallback } from "react";
import { useSearchParams } from "react-router";

const PARAM = "driver";

export interface DriverSelection {
  /** The selected driver number, or null when absent/unparseable. */
  selected: number | null;
  /** Selects a driver, or clears the selection if it is already the one selected. */
  toggle: (driverNumber: number) => void;
  clear: () => void;
}

function parse(searchParams: URLSearchParams): number | null {
  const raw = searchParams.get(PARAM);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function useDriverSelection(): DriverSelection {
  const [searchParams, setSearchParams] = useSearchParams();

  const toggle = useCallback(
    (driverNumber: number) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (previous.get(PARAM) === String(driverNumber)) {
            next.delete(PARAM);
          } else {
            next.set(PARAM, String(driverNumber));
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const clear = useCallback(() => {
    setSearchParams(
      (previous) => {
        if (!previous.has(PARAM)) return previous;
        const next = new URLSearchParams(previous);
        next.delete(PARAM);
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  return { selected: parse(searchParams), toggle, clear };
}
