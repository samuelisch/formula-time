import { useEffect, useState } from "react";

import { useBoardIsRacing } from "../board/useBoardState.ts";
import { Pill, type PillTone } from "../components/Pill.tsx";
import { useCatchingUp, useConnection, useLastMessageAt } from "./selectors.ts";

// A stoppage must read as a quiet feed, never a frozen app (POC quiet-feed rule).
const QUIET_AFTER_MS = 5_000;

function pillState(
  connection: ReturnType<typeof useConnection>,
  catchingUp: boolean,
  lastMessageAt: number | null,
  now: number,
): { text: string; tone: PillTone } {
  if (connection === "connecting") return { text: "connecting…", tone: "neutral" };
  if (connection === "reconnecting") return { text: "Live · reconnecting…", tone: "warn" };
  if (catchingUp) return { text: "Live · catching up", tone: "live" };

  if (lastMessageAt !== null && now - lastMessageAt >= QUIET_AFTER_MS) {
    const quietSeconds = Math.floor((now - lastMessageAt) / 1000);
    return { text: `Live · last update ${quietSeconds}s ago`, tone: "live" };
  }

  return { text: "Live · connected", tone: "live" };
}

/**
 * The live route's connection indicator. Renders only while racing has
 * begun (`useBoardIsRacing()`, the same gate BoardPage's transport bar and
 * align button use): "connected" means connected to the OpenF1 session, so
 * with no session, or one that has not started or has finished, there is
 * nothing to show -- the finished/upcoming banner already explains that
 * state. The fold is the authority on whether racing has begun, not the
 * session row alone, since the row can lag it by one lifecycle check. Ticks
 * once a second so the "last update Ns ago" wording keeps advancing even
 * when no new push arrives.
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
  return <Pill tone={pill.tone}>{pill.text}</Pill>;
}
