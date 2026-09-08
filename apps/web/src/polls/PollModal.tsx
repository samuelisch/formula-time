// The board's poll pop-up: backdrop, dialog, close on backdrop click or
// Escape. Pops itself open per the POC's app.js onPollsUpdate signature
// rule (verbatim there): first time the displayed polls contain an open
// poll, and each time the count of resolved polls grows -- never re-pops
// for an unchanged set, including across an unmount/remount (BoardPage and
// PollsPage are sibling routes, so navigating away and back remounts this
// component; the last-seen signature lives in the pollModalStore singleton,
// not a local ref, so it survives that -- see pollModalStore.ts). The
// signature is scoped to the session key (`useDisplayed()?.session_key`) so
// a new race starts it fresh rather than comparing across sessions.
// `polls` is passed in (from `usePolls()` at the mount site in BoardPage)
// so this stays testable by rerendering with new props rather than driving
// the live store.
import { useEffect } from "react";

import { useDisplayed } from "../live/selectors.ts";
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
  const sessionKey = useDisplayed()?.session_key ?? null;
  const isOpen = usePollModalUiStore((state) => state.isOpen);
  const open = usePollModalUiStore((state) => state.open);
  const close = usePollModalUiStore((state) => state.close);

  useEffect(() => {
    const signature = signatureOf(polls);
    const store = usePollModalUiStore.getState();
    // A session change (a new race) starts the comparison fresh, same as a cold mount.
    const previous = store.lastSessionKey === sessionKey ? store.lastSignature : "";

    if (signature !== previous) {
      const previousResolved = previous.split("|").filter((entry) => entry.endsWith(":resolved")).length;
      const nowResolved = polls.filter((poll) => poll.status === "resolved").length;
      const newlyOpen = signature.includes(":open") && !previous.includes(":open");
      usePollModalUiStore.getState().setSignature(signature, sessionKey);
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
    <div className={styles.backdrop} onClick={close}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Race polls"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className={styles.close} onClick={close} aria-label="Close">
          ×
        </button>
        <PollList polls={polls} />
      </div>
    </div>
  );
}
