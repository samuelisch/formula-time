import type { ReactNode } from "react";

import styles from "./Pill.module.css";

export type PillTone = "neutral" | "live" | "warn";

export interface PillProps {
  children: ReactNode;
  tone?: PillTone;
}

/** A small status badge, e.g. the shell's connection indicator. */
export function Pill({ children, tone = "neutral" }: PillProps) {
  return (
    <span className={`${styles.pill} ${styles[tone]}`}>
      <span className={styles.dot} aria-hidden="true" />
      {children}
    </span>
  );
}
