// Reusable disclosure: a `summary` trigger (a native <button>, so Enter/Space
// and focus come for free) that shows or hides `children`. Uncontrolled by
// default (`defaultOpen`); pass `open`/`onToggle` to drive it from a parent
// instead -- PollCard uses the uncontrolled form, keyed by poll status.
import { useId, useState, type ReactNode } from "react";

import { cx } from "../lib/classNames.ts";
import styles from "./Collapsible.module.css";

export interface CollapsibleProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  className?: string;
}

export function Collapsible({ summary, children, defaultOpen = false, open, onToggle, className }: CollapsibleProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : uncontrolledOpen;
  const contentId = useId();

  function toggle(): void {
    const next = !isOpen;
    if (!isControlled) setUncontrolledOpen(next);
    onToggle?.(next);
  }

  return (
    <div className={cx(styles.collapsible, className)}>
      <button type="button" className={styles.trigger} aria-expanded={isOpen} aria-controls={contentId} onClick={toggle}>
        {summary}
      </button>
      <div id={contentId} className={styles.content} hidden={!isOpen}>
        {children}
      </div>
    </div>
  );
}
