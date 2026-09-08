// Reusable `useQuery` state gate (issue #94): distinguishes "loading" and
// "could not load" (with a Retry button calling `refetch()`) from the
// success case, which renders `children` -- an empty *successful* result is
// the caller's concern (its own empty-state copy inside `children`), not
// this component's. Used by PollsPage (the historical-race polls fetch) and
// RacesPage (the races index), so both distinguish a failed fetch from a
// genuinely empty list instead of showing the same "nothing here" text.
import type { ReactNode } from "react";

import styles from "./QueryState.module.css";

export type QueryStateStatus = "pending" | "error" | "success";

export interface QueryStateProps {
  status: QueryStateStatus;
  /** The query's error, if any -- accepted for callers that want to log or inspect it; not rendered directly (`errorText` is the friendly, fixed copy the product wants shown). */
  error: unknown;
  onRetry: () => void;
  loadingText: string;
  errorText: string;
  children: ReactNode;
}

export function QueryState({ status, onRetry, loadingText, errorText, children }: QueryStateProps) {
  if (status === "pending") {
    return <p className={styles.quiet}>{loadingText}</p>;
  }

  if (status === "error") {
    return (
      <p className={styles.error}>
        {errorText}{" "}
        <button type="button" className={styles.retry} onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  }

  return <>{children}</>;
}
