import type { ReactNode } from "react";

import styles from "./StatusLine.module.css";

export interface StatusLineProps {
  label: string;
  value: ReactNode;
}

/** A label/value row, e.g. the board's lap counter and delay readout. */
export function StatusLine({ label, value }: StatusLineProps) {
  return (
    <div className={styles.line}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
    </div>
  );
}
