// The board's poll pop-up: backdrop, dialog, close on backdrop click or
// Escape. Auto-opens only for a transition the viewer's own tab has
// watched happen: the first signature observed for a session is seeded
// without opening, so a cold page load (or a fresh race) never auto-pops
// for poll state that arrived before this tab was watching. Only a later
// change for the same session pops it -- a newly open poll, or the count
// of resolved polls growing -- never re-pops for an unchanged set,
// including across an unmount/remount (BoardPage and PollsPage are sibling
// routes, so navigating away and back remounts this component; the
// last-seen signature lives in the pollModalStore singleton, not a local
// ref, so it survives that -- see pollModalStore.ts). The signature is
// scoped to the session key, read off the same push as the polls
// themselves (`useBoardPush()?.session_key`), so a new race re-seeds
// instead of comparing across sessions.
// `polls` is passed in (from `usePolls()` at the mount site in BoardPage)
// so this stays testable by rerendering with new props rather than driving
// the live store.
import { useEffect, useRef } from "react";

import { useBoardPush } from "../board/useBoardState.ts";
import { focusableElements, trapTabKey } from "../components/focusTrap.ts";
import { cx } from "../lib/classNames.ts";
import { useNarrowViewport } from "../lib/useNarrowViewport.ts";
import type { PollPublic } from "../live/types.ts";
import { PollList } from "./PollList.tsx";
import styles from "./PollModal.module.css";
import { usePollModalUiStore } from "./pollModalStore.ts";

export interface PollModalProps {
  polls: PollPublic[];
}

function signatureOf(polls: PollPublic[]): string {
  return polls.map((poll) => `${poll.poll_id}:${poll.status}`).join("|");
}

export function PollModal({ polls }: PollModalProps) {
  const sessionKey = useBoardPush()?.session_key ?? null;
  const isOpen = usePollModalUiStore((state) => state.isOpen);
  const open = usePollModalUiStore((state) => state.open);
  const close = usePollModalUiStore((state) => state.close);
  // Under the narrow breakpoint the dialog becomes a bottom sheet
  // (PollModal.module.css); the variant is read in JS, not left to a media
  // query alone, so it is one flag driving both the backdrop alignment and
  // the sheet's own shape.
  const narrow = useNarrowViewport();

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // On open: remember what had focus (to give it back on close) and move
  // focus to the first option button, or the close button when the dialog
  // holds no other focusable control (e.g. "No polls yet"). On close, the
  // cleanup below returns focus to the opener -- this runs whether the
  // dialog closes via Escape, the backdrop, or the close button, since all
  // three go through the same `isOpen` state.
  useEffect(() => {
    if (!isOpen) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const dialog = dialogRef.current;
    if (dialog !== null) {
      // The first option (vote) button, not the close button and not a
      // PollCard's own disclosure trigger (which carries aria-expanded) --
      // a viewer opens the dialog to vote, so that is what should have
      // focus first.
      const firstOption = focusableElements(dialog).find(
        (element) => element !== closeButtonRef.current && !element.hasAttribute("aria-expanded"),
      );
      (firstOption ?? closeButtonRef.current)?.focus();
    }

    return () => {
      openerRef.current?.focus();
    };
  }, [isOpen]);

  useEffect(() => {
    const signature = signatureOf(polls);
    const store = usePollModalUiStore.getState();

    if (store.lastSessionKey !== sessionKey) {
      // First signature observed for this session (including a cold mount,
      // where the store still holds its initial null): record it without
      // opening. Only a later change for this same session may pop.
      store.setSignature(signature, sessionKey);
      return;
    }

    const previous = store.lastSignature;
    if (signature !== previous) {
      const previousResolved = previous.split("|").filter((entry) => entry.endsWith(":resolved")).length;
      const nowResolved = polls.filter((poll) => poll.status === "resolved").length;
      const newlyOpen = signature.includes(":open") && !previous.includes(":open");
      store.setSignature(signature, sessionKey);
      if (nowResolved > previousResolved || newlyOpen) open();
    }
  }, [polls, sessionKey, open]);

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, close]);

  if (!isOpen) return null;

  return (
    <div className={cx(styles.backdrop, narrow && styles.backdropSheet)} onClick={close}>
      <div
        ref={dialogRef}
        className={cx(styles.dialog, narrow && styles.sheet)}
        role="dialog"
        aria-modal="true"
        aria-label="Race polls"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (dialogRef.current !== null) trapTabKey(dialogRef.current, event);
        }}
      >
        <button type="button" ref={closeButtonRef} className={styles.close} onClick={close} aria-label="Close">
          ×
        </button>
        <PollList polls={polls} />
      </div>
    </div>
  );
}
