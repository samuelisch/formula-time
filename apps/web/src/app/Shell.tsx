import type { RawRecord } from "@formula-time/domain";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";

import { Pill, type PillTone } from "../components/Pill.tsx";
import { useCatchingUp, useConnection, useLastMessageAt, useSessionMeta } from "../live/selectors.ts";
import { useLiveStream } from "../live/useLiveStream.ts";
import styles from "./Shell.module.css";

// A stoppage must read as a quiet feed, never a frozen app (POC quiet-feed rule).
const QUIET_AFTER_MS = 5_000;

function sessionLine(session: RawRecord | null): string {
  if (session === null) return "Waiting for a session";
  const country = typeof session.country_name === "string" ? session.country_name : null;
  const circuit = typeof session.circuit_short_name === "string" ? session.circuit_short_name : null;
  if (country === null && circuit === null) return "Waiting for a session";
  return `${country ?? "?"} · ${circuit ?? "?"}`;
}

function pillState(
  connection: ReturnType<typeof useConnection>,
  catchingUp: boolean,
  lastMessageAt: number | null,
  now: number,
): { text: string; tone: PillTone } {
  if (connection === "connecting") return { text: "connecting…", tone: "neutral" };
  if (connection === "reconnecting") return { text: "Live · reconnecting…", tone: "warn" };

  if (catchingUp) return { text: "Live · catching up", tone: "live" };

  if (lastMessageAt !== null) {
    const quietSeconds = Math.floor((now - lastMessageAt) / 1000);
    if (now - lastMessageAt >= QUIET_AFTER_MS) {
      return { text: `Live · last update ${quietSeconds}s ago`, tone: "live" };
    }
  }

  return { text: "Live · connected", tone: "live" };
}

export function Shell() {
  useLiveStream();

  const connection = useConnection();
  const catchingUp = useCatchingUp();
  const lastMessageAt = useLastMessageAt();
  const { session } = useSessionMeta();

  // Ticks once a second so the "last update Ns ago" pill keeps advancing
  // even when no new push arrives.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  const pill = pillState(connection, catchingUp, lastMessageAt, now);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.title}>FormulaTime</h1>
        <span className={styles.session}>{sessionLine(session)}</span>
        <nav className={styles.nav}>
          <NavLink to="/" end>
            Board
          </NavLink>
          <NavLink to="/polls">Polls</NavLink>
        </nav>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
      <footer className={styles.footer}>Timing data by OpenF1. Not affiliated with Formula 1.</footer>
    </div>
  );
}
