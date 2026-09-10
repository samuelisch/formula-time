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
import { useEffect } from "react";

import { useBoardPush } from "../board/useBoardState.ts";
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
