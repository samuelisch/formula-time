// Keyboard focus containment for a dialog: which of its descendants can
// currently take focus, and wrapping Tab/Shift+Tab at the ends of that list
// so focus never leaves the dialog while it is open. No dependency -- the
// dialog itself (PollModal.tsx) owns remembering and restoring the opener's
// focus, since that lifecycle is the caller's, not this helper's.
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Every element inside `container` that can currently take keyboard focus,
 * in DOM (tab) order. Excludes anything inside a `hidden` ancestor (e.g. a
 * collapsed `Collapsible`'s content), which native Tab already skips.
 */
export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.closest("[hidden]") === null,
  );
}

/**
 * Call from the dialog's `onKeyDown` while it is open: wraps Tab at the
 * last focusable element back to the first, and Shift+Tab at the first
 * back to the last, so focus stays inside `container`.
 */
export function trapTabKey(container: HTMLElement, event: ReactKeyboardEvent): void {
  if (event.key !== "Tab") return;

  const elements = focusableElements(container);
  if (elements.length === 0) return;

  const first = elements[0]!;
  const last = elements[elements.length - 1]!;
  const active = document.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
