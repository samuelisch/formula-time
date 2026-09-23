import { useEffect, useState } from "react";

import { useBoardIsRacing } from "../board/useBoardState.ts";
import { Pill, type PillTone } from "../components/Pill.tsx";
import { useCatchingUp, useConnection, useLastMessageAt } from "./selectors.ts";

// A stoppage must read as a quiet feed, never a frozen app (POC quiet-feed rule).
const QUIET_AFTER_MS = 5_000;

/**
 * `text` is the visible pill wording, ticking once a second while quiet.
 * `announce` is what a screen reader is told: the same wording except the
 * quiet-feed case, where it drops the seconds count so a live region
 * re-announces only a real connection-state change, never the tick.
 */
function pillState(
  connection: ReturnType<typeof useConnection>,
  catchingUp: boolean,
  lastMessageAt: number | null,
  now: number,
): { text: string; announce: string; tone: PillTone } {
  if (connection === "connecting") return { text: "connecting…", announce: "connecting…", tone: "neutral" };
  if (connection === "reconnecting")
    return { text: "Live · reconnecting…", announce: "Live · reconnecting…", tone: "warn" };
  if (catchingUp) return { text: "Live · catching up", announce: "Live · catching up", tone: "live" };

  if (lastMessageAt !== null && now - lastMessageAt >= QUIET_AFTER_MS) {
    const quietSeconds = Math.floor((now - lastMessageAt) / 1000);
    return { text: `Live · last update ${quietSeconds}s ago`, announce: "Live · quiet feed", tone: "live" };
  }

  return { text: "Live · connected", announce: "Live · connected", tone: "live" };
}

/**
 * The live route's connection indicator. Renders only while racing has
 * begun (`useBoardIsRacing()`); the finished/upcoming banner covers the
 * rest. Ticks once a second so the wording keeps advancing.
 * See README: BoardPage.
 */
export function ConnectionPill() {
  const isRacing = useBoardIsRacing();
  const connection = useConnection();
  const catchingUp = useCatchingUp();
  const lastMessageAt = useLastMessageAt();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRacing) return;
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [isRacing]);

  if (!isRacing) return null;

  const pill = pillState(connection, catchingUp, lastMessageAt, now);
  return (
    <span role="status" aria-label={pill.announce}>
      <Pill tone={pill.tone}>{pill.text}</Pill>
    </span>
  );
}
