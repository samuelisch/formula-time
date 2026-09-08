import type { ReactNode } from "react";

import styles from "./Card.module.css";

export interface CardProps {
  children: ReactNode;
  className?: string;
}

/** A raised surface panel: the reusable primitive for board and poll content. */
export function Card({ children, className }: CardProps) {
  return <div className={className === undefined ? styles.card : `${styles.card} ${className}`}>{children}</div>;
}
