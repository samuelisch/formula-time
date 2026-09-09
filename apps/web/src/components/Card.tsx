import type { ReactNode } from "react";

import { cx } from "../lib/classNames.ts";
import styles from "./Card.module.css";

export interface CardProps {
  children: ReactNode;
  className?: string;
}

/** A raised surface panel: the reusable primitive for board and poll content. */
export function Card({ children, className }: CardProps) {
  return <div className={cx(styles.card, className)}>{children}</div>;
}
