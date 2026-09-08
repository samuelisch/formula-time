// Board toolbar entry point for polls: opens the modal, shows the open
// count. Reads polls itself via usePolls() (the displayed push, through the
// board seam -- empty under a replay) so BoardPage's mount stays a single
// `<PollsButton />` with no props.
import styles from "./PollsButton.module.css";
import { usePollModalUiStore } from "./pollModalStore.ts";
import { usePolls } from "./usePolls.ts";

export function PollsButton() {
  const polls = usePolls();
  const open = usePollModalUiStore((state) => state.open);
  const openCount = polls.filter((poll) => poll.status === "open").length;

  return (
    <button type="button" className={styles.button} onClick={open}>
      Polls{openCount > 0 ? ` (${openCount})` : ""}
    </button>
  );
}
